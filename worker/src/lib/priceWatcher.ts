// PriceWatcher Durable Object — one instance per market with pending orders.
//
// Responsibilities:
//   1. Maintain a single WebSocket connection to DFlow's `prices` channel
//      for this market.
//   2. On every price tick, query D1 for pending+armed orders on this
//      market, evaluate triggers, and dispatch to the submission path on
//      the first crossing.
//   3. Reconnect with exponential backoff on disconnect.
//   4. Self-spin-down when no pending orders remain (DO storage TTL via
//      alarm()).
//
// Wake protocol: the API calls `fetch(/wake?market=<ticker>)` on the DO
// stub when a new order lands. The DO opens its WS if not already open
// and refreshes its in-memory order list.
//
// All actual submission lives in `lib/submitter.ts` so the DO doesn't have
// to know about Helius RPC mechanics — it just reports "this order is
// armed" and `submitter` takes it from there.

import type { Env } from '../env'
import { incr } from './metrics'
import { pricesFromMessage, type Prices } from './triggers'
import {
  reapStuckSubmissions, pollPendingConfirmations, fetchOpenOrders, evaluateAll,
} from './orderEval'
import {
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, HEARTBEAT_TIMEOUT_MS, ALARM_REEVAL_MS,
} from './constants'

export class PriceWatcher implements DurableObject {
  private state: DurableObjectState
  private env: Env
  private ws: WebSocket | null = null
  private reconnectAttempts = 0
  // Reconnect scheduling lives on the DO's alarm — not setTimeout — so
  // hibernation and crash-recovery converge on the same code path. The
  // previous setTimeout-based reconnect could race the alarm and produce
  // double-`maybeOpen` calls (only the `opening` flag prevented that).
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastMessageAt = 0
  private marketTicker: string | null = null
  private opening = false

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    // Restore market ticker after a hibernation/restart so we can resume
    // the WS subscription without being woken by an order placement.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<string>('marketTicker')
      if (stored) {
        this.marketTicker = stored
        await this.maybeOpen()
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const ticker = url.searchParams.get('market')

    if (url.pathname.endsWith('/wake')) {
      if (!ticker) return new Response('market required', { status: 400 })
      this.marketTicker = ticker
      await this.state.storage.put('marketTicker', ticker)
      await this.maybeOpen()
      // Eagerly evaluate in case prices are already stable around the trigger.
      // No-op if WS hasn't delivered a price yet.
      await this.runEval()
      return Response.json({ ok: true, market: ticker })
    }

    if (url.pathname.endsWith('/status')) {
      return Response.json({
        market: this.marketTicker,
        wsOpen: this.ws?.readyState === WebSocket.OPEN,
        reconnectAttempts: this.reconnectAttempts,
      })
    }

    if (url.pathname.endsWith('/shutdown')) {
      this.closeWs()
      this.marketTicker = null
      await this.state.storage.deleteAll()
      return Response.json({ ok: true })
    }

    return new Response('Not found', { status: 404 })
  }

  // Alarm fires periodically as a safety net: reaps stuck submissions,
  // re-evaluates pending orders against the last cached price, and
  // verifies the WS is healthy. If there are no pending orders, the DO
  // shuts itself down.
  async alarm(): Promise<void> {
    if (!this.marketTicker) return
    // Order matters:
    //   1. Reap rows whose send stalled (submitting + no signature, old).
    //   2. Poll confirmation for rows that broadcast successfully but
    //      haven't confirmed yet (submitting + signature).
    //   3. Re-evaluate triggers for pending/armed.
    //   4. Shut down if nothing is left to watch.
    await reapStuckSubmissions(this.env, this.marketTicker)
    await pollPendingConfirmations(this.env, this.marketTicker)
    const open = await fetchOpenOrders(this.env, this.marketTicker)
    if (open.length === 0) {
      this.closeWs()
      await this.state.storage.deleteAll()
      return
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.maybeOpen()
    }
    await this.runEval()
    await this.state.storage.setAlarm(Date.now() + ALARM_REEVAL_MS)
  }

  private async runEval(): Promise<void> {
    if (!this.marketTicker) return
    let cur = await this.state.storage.get<Prices>('lastPrice')
    // WS is event-driven — DFlow's `prices` channel only emits on best
    // bid/ask changes. In quiet markets the keeper can sit waiting for a
    // tick that never comes, leaving lastPrice null. Fall back to a REST
    // snapshot so triggers still evaluate against the current book.
    if (!cur) {
      const snap = await this.fetchOrderbookSnapshot(this.marketTicker).catch((err) => {
        console.error('price_watcher_orderbook_snapshot_failed', { error: String(err), market: this.marketTicker })
        return null
      })
      if (snap) {
        cur = snap
        await this.state.storage.put('lastPrice', snap).catch(() => {})
      }
    }
    console.log('price_watcher_runEval', {
      market: this.marketTicker,
      hasLastPrice: !!cur,
      yesAsk: cur?.yesAsk ?? null,
      yesBid: cur?.yesBid ?? null,
      wsOpen: this.ws?.readyState === WebSocket.OPEN,
    })
    if (!cur) return
    await evaluateAll(this.env, this.marketTicker, cur)
  }

  private async fetchOrderbookSnapshot(ticker: string): Promise<Prices | null> {
    const url = `${this.env.DFLOW_REST_BASE}/api/v1/orderbook/${encodeURIComponent(ticker)}`
    const res = await fetch(url, { headers: { 'x-api-key': this.env.DFLOW_API_KEY } })
    if (!res.ok) {
      console.error('price_watcher_orderbook_http_error', { market: ticker, status: res.status })
      return null
    }
    const body = await res.json<{ yes_bids?: Record<string, number>; no_bids?: Record<string, number> }>().catch(() => null)
    if (!body) return null
    const maxKey = (m?: Record<string, number>): number | null => {
      if (!m) return null
      let best = -Infinity
      for (const k of Object.keys(m)) {
        const n = parseFloat(k)
        if (Number.isFinite(n) && n > best) best = n
      }
      return Number.isFinite(best) ? best : null
    }
    const topYesBid = maxKey(body.yes_bids)
    const topNoBid = maxKey(body.no_bids)
    const prices: Prices = {
      yesBid: topYesBid,
      yesAsk: topNoBid != null ? 1 - topNoBid : null,
      noBid: topNoBid,
      noAsk: topYesBid != null ? 1 - topYesBid : null,
    }
    if (prices.yesAsk == null && prices.yesBid == null && prices.noAsk == null && prices.noBid == null) return null
    return prices
  }

  private async maybeOpen(): Promise<void> {
    if (!this.marketTicker) return
    if (this.opening) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return

    this.opening = true
    try {
      // Cloudflare Workers WebSocket fetch upgrade. The `x-api-key` header
      // is set on the upgrade request — exactly what browsers can't do
      // and the reason this code lives in the worker, not the frontend.
      //
      // Workers' fetch() rejects `wss://`/`ws://` schemes ("Fetch API cannot
      // load") — the upgrade has to use `https://`/`http://` and rely on the
      // `Upgrade: websocket` header to negotiate the protocol switch. We keep
      // DFLOW_WS_URL stored as `wss://` because it's the canonical form for
      // every other consumer (docs, browser env), and translate here.
      const upgradeUrl = this.env.DFLOW_WS_URL
        .replace(/^wss:\/\//i, 'https://')
        .replace(/^ws:\/\//i, 'http://')
      const upstream = await fetch(upgradeUrl, {
        headers: {
          Upgrade: 'websocket',
          'x-api-key': this.env.DFLOW_API_KEY,
        },
      })
      if (!upstream.webSocket) {
        throw new Error(`DFlow WS upgrade failed: status=${upstream.status}`)
      }
      const sock = upstream.webSocket
      sock.accept()
      this.ws = sock
      this.lastMessageAt = Date.now()
      this.reconnectAttempts = 0
      this.startHeartbeat()

      sock.addEventListener('message', (ev) => this.onMessage(ev))
      sock.addEventListener('close', () => this.onClose())
      sock.addEventListener('error', () => this.onClose())

      const subPayload = {
        type: 'subscribe',
        channel: 'prices',
        tickers: [this.marketTicker],
      }
      sock.send(JSON.stringify(subPayload))
      console.log('price_watcher_ws_opened', {
        market: this.marketTicker,
        upstreamStatus: upstream.status,
        subscribe: subPayload,
      })

      // Schedule the safety alarm.
      await this.state.storage.setAlarm(Date.now() + ALARM_REEVAL_MS)
    } catch (err) {
      console.error('price_watcher_open_failed', { error: String(err), market: this.marketTicker })
      this.scheduleReconnect()
    } finally {
      this.opening = false
    }
  }

  private onMessage(event: MessageEvent): void {
    this.lastMessageAt = Date.now()
    let msg: any
    try { msg = JSON.parse(typeof event.data === 'string' ? event.data : '') } catch { return }
    console.log('price_watcher_ws_message', {
      market: this.marketTicker,
      channel: msg?.channel,
      type: msg?.type,
      msg_market_ticker: msg?.market_ticker,
      yes_ask: msg?.yes_ask,
      yes_bid: msg?.yes_bid,
    })
    if (!msg || msg.channel !== 'prices' || msg.market_ticker !== this.marketTicker) return
    const prices = pricesFromMessage(msg)
    if (!prices) return
    // Cache last price quad for alarm-driven re-eval and crash recovery.
    // We persist the full bid/ask quad rather than a single number because
    // limit orders evaluate against asks and stop/take-profit against
    // bids — a single-side cache would miss-eval on restart.
    this.state.storage.put('lastPrice', prices).catch(() => {})
    if (this.marketTicker) {
      evaluateAll(this.env, this.marketTicker, prices).catch((err) =>
        console.error('price_watcher_eval_failed', { error: String(err), market: this.marketTicker }),
      )
    }
  }

  private onClose(): void {
    this.stopHeartbeat()
    this.ws = null
    if (this.marketTicker) {
      incr(this.env, 'ws_disconnect', { marketTicker: this.marketTicker }).catch(() => { /* */ })
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (!this.marketTicker) return
    // Schedule the alarm slightly sooner than the regular re-eval cadence
    // proportional to attempts. The alarm handler will call maybeOpen if
    // the WS is still down at that point.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS)
    this.reconnectAttempts++
    this.state.storage.setAlarm(Date.now() + delay).catch(() => { /* alarm scheduling races are benign */ })
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
        // Silent connection — force-close so reconnect logic kicks in.
        try { this.ws?.close() } catch { /* */ }
      }
    }, 15000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private closeWs(): void {
    this.stopHeartbeat()
    if (this.ws) {
      try { this.ws.close() } catch { /* */ }
      this.ws = null
    }
  }

}

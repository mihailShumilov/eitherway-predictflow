import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { generateDepthData } from '../data/mockDetailData'
import { normalizeLevel } from '../lib/normalize'
import { getChartPalette } from '../lib/palette'
import { useKeeperOrders } from '../hooks/useKeeperOrders'
import { useConditionalOrders } from '../hooks/useConditionalOrders'

const DFLOW_BASE = '/api/dflow'

const ACTIVE_ORDER_STATUSES = new Set(['pending', 'armed', 'submitting'])

function withCumulative(levels, { reverse = false } = {}) {
  const sorted = [...levels].sort((a, b) => reverse ? b.price - a.price : a.price - b.price)
  let cum = 0
  const out = sorted.map(l => ({ price: l.price, size: l.size, cumulative: (cum += l.size) }))
  return reverse ? out.reverse() : out
}

export default function DepthChart({ market }) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 192 })
  const [book, setBook] = useState(null)
  const [hoverX, setHoverX] = useState(null)

  useEffect(() => {
    let cancelled = false
    const ticker = market.ticker || market.id
    async function load() {
      try {
        const res = await fetch(`${DFLOW_BASE}/api/v1/orderbook/${encodeURIComponent(ticker)}`)
        if (!res.ok) throw new Error(`Orderbook API: ${res.status}`)
        const data = await res.json()
        const rawBids = (data.bids || data.buy || data.data?.bids || []).map(normalizeLevel).filter(Boolean)
        const rawAsks = (data.asks || data.sell || data.data?.asks || []).map(normalizeLevel).filter(Boolean)
        if (!rawBids.length && !rawAsks.length) throw new Error('Empty orderbook')
        if (!cancelled) {
          setBook({
            bids: withCumulative(rawBids, { reverse: true }),
            asks: withCumulative(rawAsks),
          })
        }
      } catch {
        if (!cancelled) setBook(null)
      }
    }
    load()
    return () => { cancelled = true }
  }, [market.id, market.ticker])

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: Math.floor(width), height: Math.max(160, Math.floor(height)) })
      }
    })
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const { orders: keeperOrders } = useKeeperOrders()
  const { orders: localOrders } = useConditionalOrders()

  // Active orders for this market, projected onto the YES price axis so
  // they line up with the depth chart. NO-side orders are mirrored
  // (`1 - triggerPrice`) — buying NO at $X is the same price level as
  // selling YES at $1 - $X on the YES axis.
  const userOrders = useMemo(() => {
    const all = [...(keeperOrders || []), ...(localOrders || [])]
    return all
      .filter(o => ACTIVE_ORDER_STATUSES.has(o.status))
      .filter(o =>
        (market.ticker && o.marketTicker === market.ticker) ||
        (market.id && o.marketId === market.id),
      )
      .map(o => {
        const trigger = Number(o.triggerPrice)
        if (!Number.isFinite(trigger)) return null
        return {
          id: o.id,
          orderType: o.orderType || 'limit',
          side: o.side,
          triggerPrice: trigger,
          yesAxisPrice: o.side === 'no' ? 1 - trigger : trigger,
        }
      })
      .filter(Boolean)
  }, [keeperOrders, localOrders, market.ticker, market.id])

  const { bids, asks, midPrice, maxSize, minPrice, maxPrice } = useMemo(() => {
    const resolved = book || generateDepthData(market.yesBid, market.yesAsk, 20)
    const mid = (market.yesBid + market.yesAsk) / 2
    const allSizes = [...resolved.bids, ...resolved.asks].map(l => l.cumulative)
    const maxSize = Math.max(1, ...allSizes)
    const prices = [...resolved.bids, ...resolved.asks].map(l => l.price)
    // Pad a touch around user-order triggers so a marker just outside the
    // book's current range still lands on-chart.
    const orderPrices = userOrders.map(o => o.yesAxisPrice)
    return {
      bids: resolved.bids,
      asks: resolved.asks,
      midPrice: mid,
      maxSize,
      minPrice: Math.min(mid, ...prices, ...orderPrices),
      maxPrice: Math.max(mid, ...prices, ...orderPrices),
    }
  }, [book, market.yesBid, market.yesAsk, userOrders])

  const padding = { top: 5, right: 40, bottom: 22, left: 10 }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const palette = getChartPalette()
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const { width, height } = dimensions

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)

    ctx.fillStyle = palette.surface
    ctx.fillRect(0, 0, width, height)

    const chartW = width - padding.left - padding.right
    const chartH = height - padding.top - padding.bottom
    const span = maxPrice - minPrice || 0.1
    const toX = (p) => padding.left + ((p - minPrice) / span) * chartW
    const toY = (size) => padding.top + chartH * (1 - size / maxSize)

    // Y labels (size)
    ctx.fillStyle = palette.muted
    ctx.font = '10px JetBrains Mono, monospace'
    ctx.textAlign = 'left'
    const yLabels = 3
    for (let i = 0; i <= yLabels; i++) {
      const frac = i / yLabels
      const size = maxSize * (1 - frac)
      const y = padding.top + chartH * frac
      const txt = size >= 1000 ? `${(size / 1000).toFixed(0)}K` : Math.round(size).toString()
      ctx.fillText(txt, width - padding.right + 5, y + 3)
    }

    // X labels
    ctx.textAlign = 'center'
    ctx.fillText(`${(minPrice * 100).toFixed(0)}¢`, toX(minPrice), height - 5)
    ctx.fillText(`${(midPrice * 100).toFixed(0)}¢`, toX(midPrice), height - 5)
    ctx.fillText(`${(maxPrice * 100).toFixed(0)}¢`, toX(maxPrice), height - 5)

    // Step area for bids/asks
    const drawSide = (levels, colorHex, direction) => {
      if (!levels.length) return
      // Step-after path from each level to the next price.
      ctx.beginPath()
      const baseY = padding.top + chartH
      const sorted = [...levels].sort((a, b) => a.price - b.price)
      const first = sorted[0]
      ctx.moveTo(toX(first.price), baseY)
      ctx.lineTo(toX(first.price), toY(first.cumulative))
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        const cur = sorted[i]
        ctx.lineTo(toX(cur.price), toY(prev.cumulative))
        ctx.lineTo(toX(cur.price), toY(cur.cumulative))
      }
      const last = sorted[sorted.length - 1]
      const endX = direction === 'bid' ? toX(midPrice) : toX(last.price)
      ctx.lineTo(endX, toY(last.cumulative))
      ctx.lineTo(endX, baseY)
      ctx.closePath()

      const grad = ctx.createLinearGradient(0, padding.top, 0, baseY)
      grad.addColorStop(0, hexAlpha(colorHex, 0.4))
      grad.addColorStop(1, hexAlpha(colorHex, 0.05))
      ctx.fillStyle = grad
      ctx.fill()

      // Outline (step-after)
      ctx.beginPath()
      ctx.moveTo(toX(first.price), toY(first.cumulative))
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        const cur = sorted[i]
        ctx.lineTo(toX(cur.price), toY(prev.cumulative))
        ctx.lineTo(toX(cur.price), toY(cur.cumulative))
      }
      ctx.strokeStyle = colorHex
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    drawSide(bids, palette.green, 'bid')
    drawSide(asks, palette.red, 'ask')

    // Mid line
    ctx.strokeStyle = palette.accent
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(toX(midPrice), padding.top)
    ctx.lineTo(toX(midPrice), padding.top + chartH)
    ctx.stroke()
    ctx.setLineDash([])

    // User keeper-held conditional orders. Drawn after the depth fills
    // so the line and label sit on top of the colored area.
    if (userOrders.length > 0) {
      ctx.font = 'bold 9px JetBrains Mono, monospace'
      ctx.textAlign = 'center'
      for (const o of userOrders) {
        const x = toX(o.yesAxisPrice)
        if (x < padding.left - 1 || x > width - padding.right + 1) continue
        const color = o.orderType === 'stop-loss'
          ? palette.red
          : o.orderType === 'take-profit'
            ? palette.green
            : palette.yellow
        ctx.strokeStyle = color
        ctx.setLineDash([4, 3])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(x, padding.top)
        ctx.lineTo(x, padding.top + chartH)
        ctx.stroke()
        ctx.setLineDash([])

        const typeLetter = o.orderType === 'stop-loss'
          ? 'SL' : o.orderType === 'take-profit' ? 'TP' : 'L'
        const label = `${typeLetter} ${o.side?.toUpperCase() || ''} ${(o.triggerPrice * 100).toFixed(1)}¢`
        const tw = ctx.measureText(label).width
        const px = 4
        const py = 2
        const bx = Math.max(padding.left, Math.min(width - padding.right - tw - px * 2, x - tw / 2 - px))
        const by = padding.top + 2
        ctx.fillStyle = hexAlpha(palette.surface, 0.85)
        ctx.fillRect(bx, by, tw + px * 2, 12 + py)
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.strokeRect(bx + 0.5, by + 0.5, tw + px * 2 - 1, 12 + py - 1)
        ctx.fillStyle = color
        ctx.fillText(label, bx + tw / 2 + px, by + 10)
      }
    }

    // Hover
    if (hoverX !== null) {
      const priceAt = minPrice + ((hoverX - padding.left) / chartW) * span
      ctx.strokeStyle = hexAlpha(palette.text, 0.18)
      ctx.lineWidth = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(toX(priceAt), padding.top)
      ctx.lineTo(toX(priceAt), padding.top + chartH)
      ctx.stroke()
      ctx.setLineDash([])
    }
  }, [bids, asks, midPrice, maxSize, minPrice, maxPrice, dimensions, hoverX, userOrders])

  useEffect(() => { draw() }, [draw])

  const handleMouseMove = useCallback((e) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    setHoverX(e.clientX - rect.left)
  }, [])

  const priceAtHover = useMemo(() => {
    if (hoverX === null) return null
    const chartW = dimensions.width - padding.left - padding.right
    const span = maxPrice - minPrice || 0.1
    return minPrice + ((hoverX - padding.left) / chartW) * span
  }, [hoverX, dimensions.width, maxPrice, minPrice])

  const hoverInfo = useMemo(() => {
    if (priceAtHover === null) return null
    const bid = [...bids].reverse().find(b => b.price <= priceAtHover)
    const ask = asks.find(a => a.price >= priceAtHover)
    return {
      price: priceAtHover,
      bidCum: bid?.cumulative || 0,
      askCum: ask?.cumulative || 0,
    }
  }, [priceAtHover, bids, asks])

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Order Book Depth
        </h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-terminal-green" />
            Bids
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-terminal-red" />
            Asks
          </span>
          {userOrders.length > 0 && (
            <span
              className="flex items-center gap-1 text-terminal-yellow"
              title="Your active conditional orders are shown as dashed lines on the chart at their trigger price"
            >
              <span className="w-2 h-2 rounded-full bg-terminal-yellow" />
              Your orders
            </span>
          )}
        </div>
      </div>
      <div ref={containerRef} className="h-48 relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverX(null)}
        />
        {hoverInfo && (hoverInfo.bidCum > 0 || hoverInfo.askCum > 0) && (
          <div className="absolute top-1 left-2 bg-terminal-card/90 border border-terminal-border rounded p-1.5 text-[10px] font-mono space-y-0.5 pointer-events-none">
            <div className="text-terminal-muted">Price: {(hoverInfo.price * 100).toFixed(1)}¢</div>
            {hoverInfo.bidCum > 0 && <div className="text-terminal-green">Bid Depth: {hoverInfo.bidCum.toLocaleString()}</div>}
            {hoverInfo.askCum > 0 && <div className="text-terminal-red">Ask Depth: {hoverInfo.askCum.toLocaleString()}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

function hexAlpha(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length !== 7) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

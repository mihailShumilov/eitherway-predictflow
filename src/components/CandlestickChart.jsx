import React, { useRef, useEffect, useState, useCallback } from 'react'
import { generateCandlesticks } from '../data/mockDetailData'

const DFLOW_BASE = '/api/dflow'

const RESOLUTIONS = [
  { key: '1h', label: '1H', count: 48 },
  { key: '4h', label: '4H', count: 42 },
  { key: '1d', label: '1D', count: 30 },
  { key: '1w', label: '1W', count: 20 },
]

function normalizeCandle(c) {
  const time = c.time ?? c.timestamp ?? c.t ?? c.openTime
  const parsedTime = typeof time === 'number' ? (time < 1e12 ? time * 1000 : time) : new Date(time).getTime()
  return {
    time: parsedTime,
    open: parseFloat(c.open ?? c.o),
    high: parseFloat(c.high ?? c.h),
    low: parseFloat(c.low ?? c.l),
    close: parseFloat(c.close ?? c.c),
    volume: parseFloat(c.volume ?? c.v ?? 0),
  }
}

const GREEN = '#10b981'
const RED = '#ef4444'
const GRID = '#1e2740'
const TEXT = '#64748b'
const BG = '#0f1423'

function formatTime(ts, resolution) {
  const d = new Date(ts)
  if (resolution === '1h' || resolution === '4h') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function CandlestickChart({ market, orderLines = [] }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [resolution, setResolution] = useState('1h')
  const [hoveredCandle, setHoveredCandle] = useState(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 300 })

  const resConfig = RESOLUTIONS.find(r => r.key === resolution)
  const [candles, setCandles] = useState([])
  const [isMock, setIsMock] = useState(false)

  useEffect(() => {
    let cancelled = false
    const ticker = market.ticker || market.id
    async function load() {
      try {
        const res = await fetch(`${DFLOW_BASE}/api/v1/market/${encodeURIComponent(ticker)}/candlesticks?resolution=${resolution}`)
        if (!res.ok) throw new Error(`Candlesticks API: ${res.status}`)
        const data = await res.json()
        const raw = Array.isArray(data) ? data : (data.data || data.candles || data.candlesticks || [])
        if (!raw.length) throw new Error('Empty candle response')
        const mapped = raw
          .map(normalizeCandle)
          .filter(c => Number.isFinite(c.open) && Number.isFinite(c.close))
        if (!mapped.length) throw new Error('No valid candles')
        if (!cancelled) {
          setCandles(mapped)
          setIsMock(false)
        }
      } catch (err) {
        if (!cancelled) {
          setCandles(generateCandlesticks(market.yesAsk, resolution, resConfig.count))
          setIsMock(true)
        }
      }
    }
    load()
    return () => { cancelled = true }
  }, [market.id, market.ticker, market.yesAsk, resolution, resConfig.count])

  const padding = { top: 20, right: 60, bottom: 30, left: 10 }

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: Math.floor(width), height: Math.max(250, Math.floor(height)) })
      }
    })
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const drawChart = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || candles.length === 0) return

    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const { width, height } = dimensions

    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    // Clear
    ctx.fillStyle = BG
    ctx.fillRect(0, 0, width, height)

    const chartW = width - padding.left - padding.right
    const chartH = height - padding.top - padding.bottom

    // Price range
    const allPrices = candles.flatMap(c => [c.high, c.low])
    const minPrice = Math.min(...allPrices) - 0.02
    const maxPrice = Math.max(...allPrices) + 0.02
    const priceRange = maxPrice - minPrice || 0.1

    const toY = (price) => padding.top + chartH * (1 - (price - minPrice) / priceRange)
    const candleWidth = Math.max(3, Math.floor(chartW / candles.length * 0.7))
    const gap = Math.max(1, Math.floor(chartW / candles.length * 0.3))

    // Grid lines
    ctx.strokeStyle = GRID
    ctx.lineWidth = 0.5
    const gridLines = 5
    for (let i = 0; i <= gridLines; i++) {
      const price = minPrice + (priceRange * i) / gridLines
      const y = toY(price)
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(width - padding.right, y)
      ctx.stroke()

      // Price labels
      ctx.fillStyle = TEXT
      ctx.font = '10px JetBrains Mono, monospace'
      ctx.textAlign = 'left'
      ctx.fillText(`${(price * 100).toFixed(0)}¢`, width - padding.right + 5, y + 3)
    }

    // Time labels
    const labelEvery = Math.max(1, Math.floor(candles.length / 6))
    ctx.fillStyle = TEXT
    ctx.font = '10px JetBrains Mono, monospace'
    ctx.textAlign = 'center'

    // Volume bars (bottom portion)
    const maxVol = Math.max(...candles.map(c => c.volume))
    const volHeight = chartH * 0.15

    candles.forEach((candle, i) => {
      const x = padding.left + i * (candleWidth + gap)
      const isGreen = candle.close >= candle.open

      // Volume bar
      const volBarH = (candle.volume / maxVol) * volHeight
      ctx.fillStyle = isGreen ? `${GREEN}33` : `${RED}33`
      ctx.fillRect(x, padding.top + chartH - volBarH, candleWidth, volBarH)

      // Wick
      const wickX = x + candleWidth / 2
      ctx.strokeStyle = isGreen ? GREEN : RED
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(wickX, toY(candle.high))
      ctx.lineTo(wickX, toY(candle.low))
      ctx.stroke()

      // Body
      const openY = toY(candle.open)
      const closeY = toY(candle.close)
      const bodyTop = Math.min(openY, closeY)
      const bodyHeight = Math.max(1, Math.abs(openY - closeY))

      ctx.fillStyle = isGreen ? GREEN : RED
      if (!isGreen) {
        ctx.fillRect(x, bodyTop, candleWidth, bodyHeight)
      } else {
        ctx.fillRect(x, bodyTop, candleWidth, bodyHeight)
      }

      // Time labels
      if (i % labelEvery === 0) {
        ctx.fillStyle = TEXT
        ctx.fillText(formatTime(candle.time, resolution), x + candleWidth / 2, height - 5)
      }
    })

    // Crosshair for hovered candle
    if (hoveredCandle !== null && hoveredCandle >= 0 && hoveredCandle < candles.length) {
      const c = candles[hoveredCandle]
      const x = padding.left + hoveredCandle * (candleWidth + gap) + candleWidth / 2
      ctx.strokeStyle = '#ffffff33'
      ctx.lineWidth = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, padding.top)
      ctx.lineTo(x, padding.top + chartH)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Order price lines
    const ORDER_LINE_COLORS = {
      limit: '#3b82f6',
      'stop-loss': '#ef4444',
      'take-profit': '#10b981',
    }
    orderLines.forEach(line => {
      if (line.triggerPrice < minPrice || line.triggerPrice > maxPrice) return
      const y = toY(line.triggerPrice)
      const color = ORDER_LINE_COLORS[line.orderType] || '#f59e0b'

      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(width - padding.right, y)
      ctx.stroke()
      ctx.setLineDash([])

      // Label
      const label = `${line.orderType === 'limit' ? 'LMT' : line.orderType === 'stop-loss' ? 'SL' : 'TP'} ${(line.triggerPrice * 100).toFixed(0)}¢`
      ctx.font = 'bold 9px JetBrains Mono, monospace'
      const textWidth = ctx.measureText(label).width
      ctx.fillStyle = color
      ctx.fillRect(width - padding.right - textWidth - 10, y - 8, textWidth + 8, 16)
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'left'
      ctx.fillText(label, width - padding.right - textWidth - 6, y + 3)
    })
  }, [candles, dimensions, hoveredCandle, resolution, orderLines])

  useEffect(() => {
    drawChart()
  }, [drawChart])

  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const chartW = dimensions.width - padding.left - padding.right
    const candleWidth = Math.max(3, Math.floor(chartW / candles.length * 0.7))
    const gap = Math.max(1, Math.floor(chartW / candles.length * 0.3))
    const idx = Math.floor((x - padding.left) / (candleWidth + gap))
    if (idx >= 0 && idx < candles.length) {
      setHoveredCandle(idx)
    } else {
      setHoveredCandle(null)
    }
  }, [candles.length, dimensions.width])

  const currentCandle = hoveredCandle !== null ? candles[hoveredCandle] : candles[candles.length - 1]
  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : currentCandle?.open
  const priceChange = currentCandle ? currentCandle.close - prevClose : 0
  const pctChange = prevClose ? ((priceChange / prevClose) * 100).toFixed(2) : '0.00'

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-4">
            <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
              Price Chart
            </h3>
            {currentCandle && (
              <div className="flex items-center gap-3 text-xs font-mono">
                <span className="text-terminal-muted">O <span className="text-terminal-text">{(currentCandle.open * 100).toFixed(1)}¢</span></span>
                <span className="text-terminal-muted">H <span className="text-terminal-green">{(currentCandle.high * 100).toFixed(1)}¢</span></span>
                <span className="text-terminal-muted">L <span className="text-terminal-red">{(currentCandle.low * 100).toFixed(1)}¢</span></span>
                <span className="text-terminal-muted">C <span className={priceChange >= 0 ? 'text-terminal-green' : 'text-terminal-red'}>{(currentCandle.close * 100).toFixed(1)}¢</span></span>
                <span className={`${priceChange >= 0 ? 'text-terminal-green' : 'text-terminal-red'}`}>
                  {priceChange >= 0 ? '+' : ''}{pctChange}%
                </span>
              </div>
            )}
          </div>
          <div className="flex bg-terminal-card border border-terminal-border rounded-lg overflow-hidden">
            {RESOLUTIONS.map(r => (
              <button
                key={r.key}
                onClick={() => setResolution(r.key)}
                className={`px-3 py-1.5 text-xs font-semibold transition-all ${
                  resolution === r.key
                    ? 'bg-terminal-accent text-white'
                    : 'text-terminal-muted hover:text-terminal-text'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div ref={containerRef} className="h-72 relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoveredCandle(null)}
        />
        {hoveredCandle !== null && currentCandle && (
          <div className="absolute top-2 left-2 bg-terminal-card/90 border border-terminal-border rounded px-2 py-1.5 text-[10px] font-mono space-y-0.5 pointer-events-none">
            <div className="text-terminal-muted">{formatTime(currentCandle.time, resolution)}</div>
            <div className="text-terminal-text">Vol: {currentCandle.volume.toLocaleString()}</div>
          </div>
        )}
      </div>
    </div>
  )
}

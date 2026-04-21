import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { getChartPalette } from '../lib/palette'

// Seeded 48-hour YES/NO history. Kept as pure canvas-drawn two-series
// area chart so we don't pull in recharts for a chart this simple.
function generatePriceHistory(currentPrice, points = 48) {
  const data = []
  let price = currentPrice + (Math.random() - 0.5) * 0.3

  for (let i = 0; i < points; i++) {
    const change = (Math.random() - 0.5) * 0.04
    price = Math.max(0.02, Math.min(0.98, price + change))
    const ts = Date.now() - (points - i) * 3600000
    data.push({ ts, yes: price, no: 1 - price })
  }

  // Force last point to equal the quoted current price.
  data[data.length - 1].yes = currentPrice
  data[data.length - 1].no = 1 - currentPrice
  return data
}

function formatHourMinute(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function PriceChart({ market }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 256 })
  const [hoverIdx, setHoverIdx] = useState(null)

  const data = useMemo(() => generatePriceHistory(market.yesAsk), [market.id])

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: Math.floor(width), height: Math.max(220, Math.floor(height)) })
      }
    })
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [])

  const padding = { top: 10, right: 44, bottom: 22, left: 10 }

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || data.length === 0) return
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

    const toX = (i) => padding.left + (chartW * i) / Math.max(1, data.length - 1)
    const toY = (price) => padding.top + chartH * (1 - price)

    // Grid (5 horizontal steps, dashed)
    ctx.strokeStyle = palette.border
    ctx.lineWidth = 0.5
    ctx.setLineDash([3, 3])
    ctx.font = '10px JetBrains Mono, monospace'
    ctx.fillStyle = palette.muted
    ctx.textAlign = 'left'
    for (let i = 0; i <= 4; i++) {
      const price = i / 4
      const y = toY(price)
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(width - padding.right, y)
      ctx.stroke()
      ctx.fillText(`${(price * 100).toFixed(0)}¢`, width - padding.right + 5, y + 3)
    }
    ctx.setLineDash([])

    // x-axis labels (first/last/mid)
    ctx.textAlign = 'center'
    const labelIdx = [0, Math.floor(data.length / 2), data.length - 1]
    for (const i of labelIdx) {
      ctx.fillText(formatHourMinute(data[i].ts), toX(i), height - 5)
    }

    const drawArea = (key, colorHex, topAlpha, bottomAlpha, strokeWidth) => {
      ctx.beginPath()
      ctx.moveTo(toX(0), toY(data[0][key]))
      for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(data[i][key]))
      ctx.lineTo(toX(data.length - 1), toY(0))
      ctx.lineTo(toX(0), toY(0))
      ctx.closePath()
      const grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH)
      grad.addColorStop(0, hexAlpha(colorHex, topAlpha))
      grad.addColorStop(1, hexAlpha(colorHex, bottomAlpha))
      ctx.fillStyle = grad
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(toX(0), toY(data[0][key]))
      for (let i = 1; i < data.length; i++) ctx.lineTo(toX(i), toY(data[i][key]))
      ctx.strokeStyle = colorHex
      ctx.lineWidth = strokeWidth
      ctx.stroke()
    }

    drawArea('no', palette.red, 0.15, 0, 1.5)
    drawArea('yes', palette.green, 0.3, 0, 2)

    // Hover crosshair + dots
    if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < data.length) {
      const x = toX(hoverIdx)
      ctx.strokeStyle = hexAlpha(palette.text, 0.2)
      ctx.lineWidth = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath()
      ctx.moveTo(x, padding.top)
      ctx.lineTo(x, padding.top + chartH)
      ctx.stroke()
      ctx.setLineDash([])

      const drawDot = (key, color) => {
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(x, toY(data[hoverIdx][key]), 3, 0, Math.PI * 2)
        ctx.fill()
      }
      drawDot('yes', palette.green)
      drawDot('no', palette.red)
    }
  }, [data, dimensions, hoverIdx])

  useEffect(() => { draw() }, [draw])

  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const chartW = dimensions.width - padding.left - padding.right
    const idx = Math.round(((x - padding.left) / chartW) * (data.length - 1))
    setHoverIdx(idx >= 0 && idx < data.length ? idx : null)
  }, [data.length, dimensions.width])

  const hovered = hoverIdx !== null ? data[hoverIdx] : null

  return (
    <div className="bg-terminal-surface border border-terminal-border rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-terminal-border flex items-center justify-between">
        <h3 className="text-xs font-semibold text-terminal-muted uppercase tracking-wider">
          Price History (48h)
        </h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-terminal-green" />
            YES
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-terminal-red" />
            NO
          </span>
        </div>
      </div>
      <div ref={containerRef} className="h-64 relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-crosshair"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        />
        {hovered && (
          <div className="absolute top-2 left-2 bg-terminal-card/90 border border-terminal-border rounded px-2 py-1.5 text-[10px] font-mono space-y-0.5 pointer-events-none">
            <div className="text-terminal-muted">{formatHourMinute(hovered.ts)}</div>
            <div className="text-terminal-green">YES {(hovered.yes * 100).toFixed(1)}¢</div>
            <div className="text-terminal-red">NO {(hovered.no * 100).toFixed(1)}¢</div>
          </div>
        )}
      </div>
    </div>
  )
}

// Convert #rrggbb to rgba(...,alpha). Inputs are always the canonical hex
// palette values, so we keep the parser narrow.
function hexAlpha(hex, alpha) {
  if (!hex || hex[0] !== '#' || hex.length !== 7) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

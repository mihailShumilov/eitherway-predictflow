import React, { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { generateDepthData } from '../data/mockDetailData'

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-2 shadow-xl text-xs font-mono">
      <div className="text-terminal-muted mb-1">Price: {(d.price * 100).toFixed(1)}¢</div>
      {d.bidCum > 0 && <div className="text-terminal-green">Bid Depth: {d.bidCum.toLocaleString()}</div>}
      {d.askCum > 0 && <div className="text-terminal-red">Ask Depth: {d.askCum.toLocaleString()}</div>}
    </div>
  )
}

export default function DepthChart({ market }) {
  const data = useMemo(() => {
    const { bids, asks } = generateDepthData(market.yesBid, market.yesAsk, 20)

    const merged = []

    // Bids (left side) - reversed so price goes low to high
    for (const b of bids) {
      merged.push({
        price: b.price,
        bidCum: b.cumulative,
        askCum: 0,
      })
    }

    // Mid-point
    const midPrice = (market.yesBid + market.yesAsk) / 2
    merged.push({ price: midPrice, bidCum: 0, askCum: 0 })

    // Asks (right side)
    for (const a of asks) {
      merged.push({
        price: a.price,
        bidCum: 0,
        askCum: a.cumulative,
      })
    }

    merged.sort((a, b) => a.price - b.price)
    return merged
  }, [market.id, market.yesBid, market.yesAsk])

  const midPrice = (market.yesBid + market.yesAsk) / 2

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
        </div>
      </div>
      <div className="p-2 h-48">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <defs>
              <linearGradient id="bidGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="askGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="price"
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}¢`}
            />
            <YAxis
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : v}
              width={40}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              x={midPrice}
              stroke="#3b82f6"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            <Area
              type="stepAfter"
              dataKey="bidCum"
              stroke="#10b981"
              strokeWidth={1.5}
              fill="url(#bidGrad)"
              dot={false}
            />
            <Area
              type="stepAfter"
              dataKey="askCum"
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="url(#askGrad)"
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

import React, { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'

function generatePriceHistory(currentPrice, points = 48) {
  const data = []
  let price = currentPrice + (Math.random() - 0.5) * 0.3

  for (let i = 0; i < points; i++) {
    const change = (Math.random() - 0.5) * 0.04
    price = Math.max(0.02, Math.min(0.98, price + change))

    const date = new Date(Date.now() - (points - i) * 3600000)
    data.push({
      time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      yes: Math.round(price * 100),
      no: Math.round((1 - price) * 100),
    })
  }

  // Ensure last point matches current price
  data[data.length - 1].yes = Math.round(currentPrice * 100)
  data[data.length - 1].no = Math.round((1 - currentPrice) * 100)

  return data
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-terminal-card border border-terminal-border rounded-lg p-2 shadow-xl">
      <p className="text-[10px] text-terminal-muted mb-1">{label}</p>
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-terminal-green">YES: {payload[0]?.value}¢</span>
        <span className="text-xs font-mono text-terminal-red">NO: {payload[1]?.value}¢</span>
      </div>
    </div>
  )
}

export default function PriceChart({ market }) {
  const data = useMemo(() => generatePriceHistory(market.yesAsk), [market.id])

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
      <div className="p-2 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 5 }}>
            <defs>
              <linearGradient id="yesGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="noGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.15} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1e2740" strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: '#64748b' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `${v}¢`}
              width={35}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="yes"
              stroke="#10b981"
              strokeWidth={2}
              fill="url(#yesGrad)"
              dot={false}
              activeDot={{ r: 3, fill: '#10b981', stroke: '#10b981' }}
            />
            <Area
              type="monotone"
              dataKey="no"
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="url(#noGrad)"
              dot={false}
              activeDot={{ r: 3, fill: '#ef4444', stroke: '#ef4444' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

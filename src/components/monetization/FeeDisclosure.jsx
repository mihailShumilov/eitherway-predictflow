import React from 'react'
import { Info } from 'lucide-react'

export default function FeeDisclosure() {
  return (
    <div className="text-[10px] text-terminal-muted/80 leading-relaxed flex items-start gap-1.5 max-w-3xl">
      <Info size={10} className="mt-0.5 shrink-0 text-terminal-muted/60" />
      <p>
        PredictFlow charges a small swap fee (0.05%–0.30% depending on plan) on each trade to sustain development.
        Live market data, charts, and your wallet's positions are free forever — non-custodial, no account required.
      </p>
    </div>
  )
}

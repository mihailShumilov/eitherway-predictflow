const now = Date.now()
const minute = 60000
const hour = 3600000

export function generateCandlesticks(basePrice, resolution = '1h', count = 48) {
  const resMs = {
    '1h': hour,
    '4h': 4 * hour,
    '1d': 24 * hour,
    '1w': 7 * 24 * hour,
  }
  const interval = resMs[resolution] || hour
  const candles = []
  let price = basePrice + (Math.random() - 0.5) * 0.2

  for (let i = count; i >= 0; i--) {
    const time = now - i * interval
    const open = price
    const volatility = 0.03 + Math.random() * 0.02
    const high = Math.min(0.99, open + Math.random() * volatility)
    const low = Math.max(0.01, open - Math.random() * volatility)
    const close = low + Math.random() * (high - low)
    const volume = Math.floor(5000 + Math.random() * 80000)

    candles.push({
      time,
      open: Math.round(open * 1000) / 1000,
      high: Math.round(high * 1000) / 1000,
      low: Math.round(low * 1000) / 1000,
      close: Math.round(close * 1000) / 1000,
      volume,
    })
    price = close
  }

  // Last candle matches current price
  if (candles.length > 0) {
    candles[candles.length - 1].close = basePrice
  }

  return candles
}

export function generateDepthData(yesBid, yesAsk, levels = 20) {
  const bids = []
  const asks = []
  let bidCumulative = 0
  let askCumulative = 0

  for (let i = 0; i < levels; i++) {
    const bidPrice = Math.max(0.01, yesBid - i * 0.005)
    const bidSize = Math.floor(3000 + Math.random() * 40000)
    bidCumulative += bidSize
    bids.push({ price: Math.round(bidPrice * 1000) / 1000, size: bidSize, cumulative: bidCumulative })
  }

  for (let i = 0; i < levels; i++) {
    const askPrice = Math.min(0.99, yesAsk + i * 0.005)
    const askSize = Math.floor(3000 + Math.random() * 40000)
    askCumulative += askSize
    asks.push({ price: Math.round(askPrice * 1000) / 1000, size: askSize, cumulative: askCumulative })
  }

  return { bids: bids.reverse(), asks }
}

export function generateRecentTrades(basePrice, count = 20) {
  const trades = []
  let price = basePrice

  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.5) * 0.04
    price = Math.max(0.01, Math.min(0.99, price + change))
    const side = Math.random() > 0.5 ? 'buy' : 'sell'
    const amount = Math.floor(50 + Math.random() * 5000)
    const timeOffset = i * (30000 + Math.random() * 120000)

    trades.push({
      id: `trade-${Date.now()}-${i}`,
      time: new Date(now - timeOffset).toISOString(),
      side,
      price: Math.round(price * 1000) / 1000,
      amount,
      total: Math.round(price * amount * 100) / 100,
    })
  }

  return trades
}

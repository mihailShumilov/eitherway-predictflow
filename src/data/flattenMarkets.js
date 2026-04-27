// Tiny utility split out of mockMarkets so it can be imported without
// pulling in the ~350 lines of mock data.
export function flattenMarkets(events) {
  const markets = []
  for (const event of events) {
    for (const market of (event.markets || [])) {
      markets.push({
        ...market,
        ticker: market.ticker || market.id,
        yesMint: market.yesMint ?? null,
        noMint: market.noMint ?? null,
        eventTitle: event.title,
        eventId: event.id,
        eventTicker: event.ticker || event.id,
        seriesTicker: event.seriesTicker || null,
        category: event.category,
        subcategory: event.subcategory,
        tags: event.tags || [],
        closeTime: market.closeTime ?? event.closeTime ?? null,
      })
    }
  }
  return markets
}

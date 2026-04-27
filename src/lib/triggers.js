// Pure trigger comparator extracted from useConditionalOrders so it can
// be unit-tested without the React/provider/setInterval ceremony.
//
// All prices are 0..1 floats. `triggerPrice` is also 0..1.

export function shouldTriggerOrder(order, currentSidePrice) {
  if (order == null || currentSidePrice == null) return false
  // Accept both `pending` and `armed`. The keeper-backed flow uses
  // `armed` after the trigger fires while submission is in flight, and
  // re-evaluates on transient submission failure. Without `armed` here
  // the legacy frontend trigger loop would silently skip the retry.
  if (order.status !== 'pending' && order.status !== 'armed') return false
  switch (order.orderType) {
    case 'limit':
    case 'stop-loss':
      return currentSidePrice <= order.triggerPrice
    case 'take-profit':
      return currentSidePrice >= order.triggerPrice
    default:
      return false
  }
}

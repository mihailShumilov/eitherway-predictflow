// Pure trigger comparator extracted from useConditionalOrders so it can
// be unit-tested without the React/provider/setInterval ceremony.
//
// All prices are 0..1 floats. `triggerPrice` is also 0..1.

export function shouldTriggerOrder(order, currentSidePrice) {
  if (order == null || currentSidePrice == null) return false
  if (order.status !== 'pending') return false
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

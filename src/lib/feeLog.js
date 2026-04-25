// Append-only log of fee events for the admin revenue dashboard. Capped at
// MAX_ENTRIES so localStorage doesn't grow unbounded — old entries roll off.

import { safeGet, safeSet } from './storage'

const KEY = 'predictflow_fee_log'
const MAX_ENTRIES = 1000

export function logFeeEvent(entry) {
  const log = safeGet(KEY, [])
  const arr = Array.isArray(log) ? log : []
  arr.push({
    timestamp: new Date().toISOString(),
    ...entry,
  })
  while (arr.length > MAX_ENTRIES) arr.shift()
  safeSet(KEY, arr)
}

export function getFeeLog() {
  const log = safeGet(KEY, [])
  return Array.isArray(log) ? log : []
}

export function clearFeeLog() {
  safeSet(KEY, [])
}

export function summarizeFeeLog(log) {
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  let total = 0
  let today = 0
  let week = 0
  let month = 0
  let trades = 0
  let referralTotal = 0
  const tierCounts = { FREE: 0, PRO: 0, WHALE: 0 }

  for (const entry of log) {
    const ts = new Date(entry.timestamp).getTime()
    const platformAmount = Number(entry.platformAmount) || 0
    const referralAmount = Number(entry.referralAmount) || 0
    total += platformAmount + referralAmount
    referralTotal += referralAmount
    trades += 1
    if (now - ts < dayMs) today += platformAmount + referralAmount
    if (now - ts < 7 * dayMs) week += platformAmount + referralAmount
    if (now - ts < 30 * dayMs) month += platformAmount + referralAmount
    if (entry.tier && tierCounts[entry.tier] !== undefined) tierCounts[entry.tier] += 1
  }

  return {
    total,
    today,
    week,
    month,
    trades,
    avgPerTrade: trades > 0 ? total / trades : 0,
    referralTotal,
    tierCounts,
  }
}

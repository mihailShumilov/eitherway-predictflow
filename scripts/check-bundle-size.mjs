#!/usr/bin/env node
// Verify the built bundle stays within budget. Run after `vite build`.
// Fails CI when a chunk crosses its gzipped threshold.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const DIST = path.resolve('dist/assets')

// Gzipped size budgets, in bytes. Tune up or down as your needs change.
const BUDGETS = [
  { match: /^index-.+\.js$/,            limit: 90 * 1024,  name: 'main entry' },
  { match: /^MarketDetail-.+\.js$/,     limit: 100 * 1024, name: 'MarketDetail lazy chunk' },
  { match: /^Portfolio-.+\.js$/,        limit: 20 * 1024,  name: 'Portfolio lazy chunk' },
  { match: /^CandlestickChart-.+\.js$/, limit: 15 * 1024,  name: 'CandlestickChart lazy chunk' },
  { match: /^ActiveOrders-.+\.js$/,     limit: 10 * 1024,  name: 'ActiveOrders lazy chunk' },
  { match: /^solana-.+\.js$/,           limit: 200 * 1024, name: 'Solana vendor chunk' },
]

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`
}

function gzSize(filePath) {
  const raw = fs.readFileSync(filePath)
  return zlib.gzipSync(raw).length
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`No dist/assets — run 'npm run build' first`)
    process.exit(1)
  }
  const files = fs.readdirSync(DIST).filter(f => f.endsWith('.js'))
  const results = []

  for (const budget of BUDGETS) {
    const file = files.find(f => budget.match.test(f))
    if (!file) {
      results.push({ budget, file: null, size: 0, over: false, missing: true })
      continue
    }
    const size = gzSize(path.join(DIST, file))
    results.push({
      budget, file, size,
      over: size > budget.limit,
      missing: false,
    })
  }

  const anyOver = results.some(r => r.over)
  const anyMissing = results.some(r => r.missing)

  console.log('\nBundle size report (gzipped):')
  console.log('─'.repeat(64))
  for (const r of results) {
    const status = r.missing ? '—' : r.over ? '✗ OVER' : '✓'
    const size = r.missing ? 'missing' : fmtKb(r.size)
    const limit = fmtKb(r.budget.limit)
    console.log(`${status.padEnd(8)} ${r.budget.name.padEnd(32)} ${size.padEnd(12)} / ${limit}`)
    if (r.file) console.log(`         ${r.file}`)
  }
  console.log('─'.repeat(64))

  if (anyOver) {
    console.error('\n✗ One or more chunks exceeded their budget.')
    process.exit(1)
  }
  if (anyMissing) {
    console.warn('\n⚠ Some budgeted chunks were not found. Check manualChunks config.')
  }
  console.log('\n✓ All chunks within budget.')
}

main()

#!/usr/bin/env node
// One-shot configurator for the PredictFlow service-commission secrets.
//
// What it does:
//   1. Derives the USDC ATA owned by the given treasury wallet.
//   2. Verifies on-chain that the ATA exists, has owner=Token program,
//      and holds the USDC mint. If not, prints an `spl-token
//      create-account` line and exits non-zero so you can't accidentally
//      configure a broken ATA.
//   3. Sets COMMISSION_RECIPIENT_USDC_ATA via wrangler.
//   4. Optionally sets COMMISSION_BPS via wrangler if --bps is passed.
//
// Usage:
//   cd worker
//   node scripts/configure-treasury.mjs <TREASURY_WALLET_PUBKEY> --bps 100
//
// Flags:
//   --bps N       Service commission in basis points (e.g. 100 = 1.00%).
//                 If omitted, only COMMISSION_RECIPIENT_USDC_ATA is set;
//                 COMMISSION_BPS keeps its current value (or remains
//                 unset, in which case commission is disabled).
//   --env NAME    wrangler env (default: production).
//   --rpc URL     RPC endpoint for the validity check (default:
//                 https://solana-rpc.publicnode.com).
//   --dry-run     Skip writing wrangler secrets; just print what would be set.
//
// Why this script exists: a misconfigured COMMISSION_RECIPIENT_USDC_ATA
// (e.g. set to a wallet pubkey instead of a derived ATA, or to an
// uninitialized address) caused every approval-flow fire to revert with
// InvalidAccountData. The keeper now degrades gracefully and skips
// commission rather than fail the order, but the operator still wants to
// configure once-correctly. This script makes the "derive + verify +
// set" sequence atomic.

import { spawn } from 'node:child_process'
import { Connection, PublicKey } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const DEFAULT_RPC = 'https://solana-rpc.publicnode.com'
const DEFAULT_ENV = 'production'

function parseArgs(argv) {
  const args = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--bps') args.bps = argv[++i]
    else if (a === '--env') args.env = argv[++i]
    else if (a === '--rpc') args.rpc = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') args.help = true
    else args.positional.push(a)
  }
  return args
}

function usage() {
  console.log(`Usage: node scripts/configure-treasury.mjs <TREASURY_WALLET_PUBKEY> [--bps N] [--env production|preview] [--rpc URL] [--dry-run]`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help || args.positional.length === 0) {
  usage()
  process.exit(args.help ? 0 : 1)
}

const wallet = args.positional[0]
const env = args.env ?? DEFAULT_ENV
const rpc = args.rpc ?? DEFAULT_RPC

let treasuryPk
try {
  treasuryPk = new PublicKey(wallet)
} catch {
  console.error(`✗ Not a valid Solana pubkey: ${wallet}`)
  process.exit(1)
}

if (args.bps !== undefined) {
  const n = Number(args.bps)
  if (!Number.isFinite(n) || n < 0 || n > 10_000 || !Number.isInteger(n)) {
    console.error(`✗ --bps must be an integer between 0 and 10000 (1.00% = 100). Got: ${args.bps}`)
    process.exit(1)
  }
}

const usdcMintPk = new PublicKey(USDC_MINT)
const ata = getAssociatedTokenAddressSync(usdcMintPk, treasuryPk, false, TOKEN_PROGRAM_ID)
const ataStr = ata.toBase58()

console.log('Treasury wallet  :', wallet)
console.log('USDC mint        :', USDC_MINT)
console.log('Derived USDC ATA :', ataStr)
console.log('RPC              :', rpc)
console.log('Wrangler env     :', env)
if (args.dryRun) console.log('(dry-run mode — no secrets will be written)')
console.log()

console.log('Verifying ATA on-chain...')
const conn = new Connection(rpc, 'confirmed')
let info
try {
  info = await conn.getAccountInfo(ata, 'confirmed')
} catch (err) {
  console.error(`✗ RPC error checking the ATA: ${err?.message ?? err}`)
  console.error('  Pass --rpc to override the endpoint.')
  process.exit(2)
}

if (!info) {
  console.error('✗ ATA does not exist on-chain. Create it first:')
  console.error('')
  console.error(`  spl-token --owner ${wallet} create-account ${USDC_MINT}`)
  console.error('')
  console.error('  (Run from a wallet with ~0.002 SOL to pay rent.)')
  console.error('  After creation, re-run this script.')
  process.exit(2)
}
if (!info.owner.equals(TOKEN_PROGRAM_ID)) {
  console.error(`✗ ATA owner is ${info.owner.toBase58()}, expected ${TOKEN_PROGRAM_ID.toBase58()} (Token program).`)
  process.exit(2)
}
if (info.data.length < 72) {
  console.error(`✗ ATA data length ${info.data.length} is too short for a token account (need ≥72 bytes).`)
  process.exit(2)
}
const mintBytes = info.data.slice(0, 32)
const expected = usdcMintPk.toBytes()
let mintMatches = true
for (let i = 0; i < 32; i++) {
  if (mintBytes[i] !== expected[i]) { mintMatches = false; break }
}
if (!mintMatches) {
  console.error('✗ ATA mint mismatch. Account exists but is not for the USDC mint.')
  process.exit(2)
}

// uiAmount for visibility (optional convenience).
const amountLamports = new DataView(
  info.data.buffer, info.data.byteOffset, info.data.byteLength,
).getBigUint64(64, true)
const amountUsdc = Number(amountLamports) / 1_000_000
console.log(`✓ ATA validated. Current balance: ${amountUsdc.toFixed(6)} USDC`)
console.log()

if (args.dryRun) {
  console.log('Would run:')
  console.log(`  wrangler secret put COMMISSION_RECIPIENT_USDC_ATA --env ${env}   (value: ${ataStr})`)
  if (args.bps !== undefined) {
    console.log(`  wrangler secret put COMMISSION_BPS --env ${env}                (value: ${args.bps})`)
  }
  process.exit(0)
}

async function setSecret(name, value) {
  console.log(`Setting ${name}...`)
  await new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name, '--env', env], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    child.stdin.write(value)
    child.stdin.end()
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`wrangler exited with code ${code}`)))
    child.on('error', reject)
  })
}

try {
  await setSecret('COMMISSION_RECIPIENT_USDC_ATA', ataStr)
  if (args.bps !== undefined) {
    await setSecret('COMMISSION_BPS', String(args.bps))
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`)
  process.exit(3)
}

console.log()
console.log('Done. Redeploy to pick up the new secrets:')
console.log(`  npx wrangler deploy --env ${env}`)
console.log()
console.log('Then watch the next approval-flow fire:')
console.log(`  npx wrangler tail predictflow-keeper-${env === 'production' ? 'prod' : env}`)
console.log()
console.log('In the approval_submit_attempt log, expect commissionSkipped: false and commission > 0.')

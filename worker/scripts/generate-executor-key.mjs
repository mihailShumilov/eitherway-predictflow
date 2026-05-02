#!/usr/bin/env node
// One-time generator for the keeper's executor keypair.
//
// Usage (default — writes the secret to a file with 0600 permissions so it
// never lands in shell history, scrollback, tmux buffers, or CI logs):
//   node scripts/generate-executor-key.mjs
//   # → prints the pubkey to stdout, writes the secret to ./executor-secret.txt
//
// Direct piping (skips the file entirely; secret only flows to wrangler):
//   node scripts/generate-executor-key.mjs --pipe | wrangler secret put EXECUTOR_SECRET_KEY --env production
//
// After generation:
//   1. wrangler secret put EXECUTOR_SECRET_KEY --env production
//      (paste contents of executor-secret.txt, then `shred -u` the file)
//   2. Verify the pubkey at https://dflow.net/proof
//   3. Fund the pubkey with ~0.01 SOL on mainnet
//   4. Redeploy the Worker so /config returns the new executor.

import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { writeFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'

const args = new Set(process.argv.slice(2))
const pipeMode = args.has('--pipe')

const kp = Keypair.generate()
const pubkey = kp.publicKey.toBase58()
const secret = bs58.encode(kp.secretKey)

if (pipeMode) {
  // The secret is the only stdout content so this can be piped directly
  // into `wrangler secret put`. The pubkey goes to stderr so it stays
  // visible in the terminal.
  process.stderr.write(`Executor pubkey: ${pubkey}\n`)
  process.stdout.write(secret)
  process.exit(0)
}

const outPath = resolve(process.cwd(), 'executor-secret.txt')
writeFileSync(outPath, secret, { mode: 0o600 })
try { chmodSync(outPath, 0o600) } catch {}

console.log('Executor pubkey :', pubkey)
console.log('Secret written  :', outPath, '(mode 0600 — DO NOT commit, DO NOT email)')
console.log()
console.log('Next steps:')
console.log('  1. wrangler secret put EXECUTOR_SECRET_KEY --env production')
console.log(`     (paste the contents of ${outPath} when prompted, then \`shred -u ${outPath}\`)`)
console.log('  2. Verify the pubkey at https://dflow.net/proof')
console.log('  3. Fund the pubkey with ~0.01 SOL on mainnet')
console.log('  4. Redeploy the Worker so /config returns the new executor.')

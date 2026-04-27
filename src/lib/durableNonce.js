// Durable nonce account lifecycle + transaction composition.
//
// Why durable nonces here:
//   A regular Solana transaction is bound to a recent blockhash, which
//   expires in roughly 90 seconds. Limit orders may sit pending for hours
//   or days waiting for a price trigger — the user can't keep re-signing.
//   Durable nonces replace the recentBlockhash with a per-account nonce
//   value that only advances when a tx using it is processed. So the
//   user signs ONCE; the keeper holds the signed bytes; submission can
//   happen any time before the user manually advances the nonce.
//
// Lifecycle:
//   1. createDurableNonce — wallet pays ~0.0015 SOL rent + system fees.
//      Returns { pubkey, currentNonce }. One per (wallet, market) pair so
//      orders for different markets don't share a nonce account (sharing
//      would make them mutually exclusive — the runtime advances the
//      nonce on first fill, invalidating any other tx bound to it).
//   2. composeOrderWithNonce — takes the DFlow /order tx + the nonce,
//      reconstructs the message with `advanceNonceAccount` as instruction
//      0 and the nonce value in the recentBlockhash slot. Returns a fresh
//      VersionedTransaction ready for the wallet to sign.
//   3. After fill, the nonce advances on-chain. Refetch with `getNonce`
//      before reusing for a future order.
//
// Address Lookup Tables: DFlow's V0 transactions may include ALTs.
// Decompiling requires the lookup table accounts to be resolved from the
// chain. We fetch them lazily via the supplied Connection.

import {
  Connection,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

// One Connection per Solana RPC URL. Used for read-only ops only —
// fetching nonce values, resolving ALTs, getting rent-exempt minimum.
// The actual transaction broadcast happens through the wallet provider
// (createNonceAccount) or the keeper backend (signed-tx submission).
const connectionCache = new Map()
function connectionFor(rpcUrl) {
  let c = connectionCache.get(rpcUrl)
  if (!c) {
    c = new Connection(rpcUrl, 'confirmed')
    connectionCache.set(rpcUrl, c)
  }
  return c
}

// Poll-based confirmation. Why not Connection.confirmTransaction:
// web3.js's confirmTransaction opens a pubsub WebSocket on a derived
// `ws://host:port+1/path` URL — it's brittle (port+1 doesn't exist
// behind our /api/rpc same-origin proxy) and the WS upgrade also wouldn't
// be reachable through Vite's HTTP middleware in dev. Polling
// getSignatureStatuses gets the same answer over plain JSON-RPC.
async function waitForConfirmation(conn, signature, timeoutMs = 90_000) {
  const start = Date.now()
  const POLL_MS = 1500
  const targets = new Set(['confirmed', 'finalized'])
  while (Date.now() - start < timeoutMs) {
    const { value } = await conn.getSignatureStatuses([signature])
    const status = value?.[0]
    if (status?.err) {
      throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`)
    }
    if (status?.confirmationStatus && targets.has(status.confirmationStatus)) {
      return
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  throw new Error(`Transaction not confirmed within ${timeoutMs}ms`)
}

// Read the current nonce value off-chain. Used both at order placement
// (to bake into the tx) and on the keeper side (to verify the signed tx
// still matches the live nonce — drift means the tx was already used or
// invalidated).
export async function getNonce(rpcUrl, noncePubkey) {
  const conn = connectionFor(rpcUrl)
  const info = await conn.getAccountInfo(new PublicKey(noncePubkey))
  if (!info) return null
  // Sanity-check the size before parsing to avoid feeding malformed data
  // to NonceAccount.fromAccountData.
  if (info.data.length < NONCE_ACCOUNT_LENGTH) return null
  const account = NonceAccount.fromAccountData(info.data)
  return account.nonce // base58 string
}

// Create + initialize a durable nonce account owned by `authority`.
// Returns the pubkey + initial nonce value once confirmed.
//
// `signAndSend` is a thin abstraction: in this codebase the active wallet
// adapter exposes either signAndSendTransaction or signTransaction. We
// take a callback so we don't tie this helper to one specific adapter
// shape. The callback should return the on-chain tx signature.
export async function createDurableNonce({
  rpcUrl,
  authorityPubkey,
  signAndSend,
}) {
  const conn = connectionFor(rpcUrl)
  const noncePubkey = Keypair.generate()
  const rentLamports = await conn.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)
  const blockhash = await conn.getLatestBlockhash('confirmed')

  const authority = new PublicKey(authorityPubkey)

  // Create + initialize is a two-instruction sequence; SystemProgram has
  // a helper that returns both. The new nonce account also signs (it's a
  // freshly-generated keypair we control).
  const ixs = SystemProgram.createNonceAccount({
    fromPubkey: authority,
    noncePubkey: noncePubkey.publicKey,
    authorizedPubkey: authority,
    lamports: rentLamports,
  }).instructions

  const message = new TransactionMessage({
    payerKey: authority,
    recentBlockhash: blockhash.blockhash,
    instructions: ixs,
  }).compileToV0Message()

  const tx = new VersionedTransaction(message)
  // Partial sign with the new nonce account keypair — the user's wallet
  // will add its signature when the user signs. Order matters: nonce
  // keypair sign first, wallet sign second.
  tx.sign([noncePubkey])

  const signature = await signAndSend(tx)

  // Wait for confirmation and read back the initial nonce value.
  await waitForConfirmation(conn, signature)

  const initialNonce = await getNonce(rpcUrl, noncePubkey.publicKey.toBase58())
  if (!initialNonce) {
    throw new Error('Nonce account confirmed but value could not be read back')
  }

  return {
    pubkey: noncePubkey.publicKey.toBase58(),
    currentNonce: initialNonce,
    signature,
  }
}

// Take a DFlow-built VersionedTransaction and rebuild it as a durable-nonce
// transaction. The returned tx is ready for the wallet to sign — the
// keeper later submits its serialized bytes verbatim.
//
// Why rebuild rather than mutate: VersionedMessage is intentionally
// immutable in @solana/web3.js, and the recentBlockhash field is part of
// the signing payload. Any change requires recompilation.
export async function composeOrderWithNonce({
  rpcUrl,
  originalTx,           // VersionedTransaction (decoded) returned by DFlow /order
  noncePubkey,
  nonceAuthority,
  currentNonce,
}) {
  if (!(originalTx instanceof VersionedTransaction) && !(originalTx instanceof Transaction)) {
    throw new Error('composeOrderWithNonce expects a (Versioned)Transaction')
  }

  // Legacy Transaction path — simpler, just unshift the advance ix and
  // set the new recentBlockhash.
  if (originalTx instanceof Transaction) {
    const advance = SystemProgram.nonceAdvance({
      noncePubkey: new PublicKey(noncePubkey),
      authorizedPubkey: new PublicKey(nonceAuthority),
    })
    const fresh = new Transaction()
    fresh.feePayer = new PublicKey(nonceAuthority)
    fresh.recentBlockhash = currentNonce
    fresh.add(advance, ...originalTx.instructions)
    return fresh
  }

  // V0 path — decompile, prepend, recompile.
  const conn = connectionFor(rpcUrl)
  const message = originalTx.message

  // Resolve every address lookup table referenced by the original message.
  // Without these, decompiled instruction account keys come back as a
  // mix of indices and resolved keys, which TransactionMessage.compile
  // refuses to round-trip.
  const altAccounts = []
  for (const lookup of message.addressTableLookups ?? []) {
    const info = await conn.getAddressLookupTable(lookup.accountKey)
    if (info?.value) altAccounts.push(info.value)
  }

  const decompiled = TransactionMessage.decompile(message, {
    addressLookupTableAccounts: altAccounts,
  })

  const advance = SystemProgram.nonceAdvance({
    noncePubkey: new PublicKey(noncePubkey),
    authorizedPubkey: new PublicKey(nonceAuthority),
  })

  const fresh = new TransactionMessage({
    payerKey: decompiled.payerKey,
    recentBlockhash: currentNonce,
    instructions: [advance, ...decompiled.instructions],
  })

  // Pass through the original ALTs so the recompiled message stays compact.
  // If we omit them, account keys explode into staticAccountKeys and the
  // tx may exceed Solana's 1232-byte hard limit.
  const newMessage = fresh.compileToV0Message(altAccounts)
  return new VersionedTransaction(newMessage)
}

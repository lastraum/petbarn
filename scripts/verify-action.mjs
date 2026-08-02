#!/usr/bin/env node
/**
 * Wallet-signature authorization for update / delete queue actions.
 *
 * The client signs (personal_sign / EIP-191):
 *   petbarn:v1:<action>:<targetId>:<glbSha256|none>:<timestampMs>
 *
 * and the Worker forwards { signature, timestampMs, glbSha256 } in meta.auth.
 * The deploy Action (this module) verifies:
 *   - the recovered address matches the target listing's wallet, or is in
 *     PETBARN_ADMIN_WALLETS (comma-separated), and
 *   - the timestamp is within the freshness window (queue → CI latency).
 *
 * Verification happens here, not in the Worker, so the Worker stays a
 *  dependency-free single file — CI has npm.
 */
import { keccak_256 } from '@noble/hashes/sha3'
import { secp256k1 } from '@noble/curves/secp256k1'

/** Freshness window (ms) — generous because CI may pick the item up late. */
export const AUTH_WINDOW_MS = Number(process.env.PETBARN_AUTH_WINDOW_MS || 60 * 60 * 1000)

export function actionMessage(action, targetId, glbSha256, timestampMs) {
  return `petbarn:v1:${action}:${targetId}:${glbSha256 || 'none'}:${timestampMs}`
}

function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error('Invalid hex string')
  }
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** EIP-191 personal_sign digest. */
function personalHash(message) {
  const msgBytes = new TextEncoder().encode(message)
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`)
  const all = new Uint8Array(prefix.length + msgBytes.length)
  all.set(prefix, 0)
  all.set(msgBytes, prefix.length)
  return keccak_256(all)
}

/** Recover the checksummed-lowercase 0x address from a personal_sign signature. */
export function recoverAddress(message, signature) {
  const sig = hexToBytes(signature)
  if (sig.length !== 65) throw new Error(`Signature must be 65 bytes, got ${sig.length}`)
  const r = sig.slice(0, 32)
  const s = sig.slice(32, 64)
  let v = sig[64]
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) throw new Error(`Unsupported recovery id ${sig[64]}`)
  const digest = personalHash(message)
  const signatureObj = secp256k1.Signature.fromCompact(
    bytesToHex(r) + bytesToHex(s)
  ).addRecoveryBit(v)
  const pub = signatureObj.recoverPublicKey(digest).toRawBytes(false)
  const addr = keccak_256(pub.slice(1)).slice(-20)
  return '0x' + bytesToHex(addr)
}

function adminWallets() {
  return (process.env.PETBARN_ADMIN_WALLETS || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Throws unless meta.auth authorizes `action` against `targetEntry`.
 * meta.auth: { signature, timestampMs, glbSha256? }
 */
export function verifyActionAuth(action, meta, targetEntry, nowMs = Date.now()) {
  const auth = meta.auth
  if (!auth || typeof auth !== 'object') {
    throw new Error(`${action} requires meta.auth { signature, timestampMs }`)
  }
  const { signature, timestampMs, glbSha256 } = auth
  if (typeof signature !== 'string' || !signature) throw new Error('auth.signature required')
  const ts = Number(timestampMs)
  if (!Number.isFinite(ts)) throw new Error('auth.timestampMs required')
  if (Math.abs(nowMs - ts) > AUTH_WINDOW_MS) {
    throw new Error(
      `auth timestamp outside freshness window (${Math.round(Math.abs(nowMs - ts) / 1000)}s old, max ${AUTH_WINDOW_MS / 1000}s)`
    )
  }

  const message = actionMessage(action, meta.targetId, glbSha256, ts)
  const recovered = recoverAddress(message, signature).toLowerCase()

  const owner = String(targetEntry.wallet || '').toLowerCase()
  const admins = adminWallets()
  if (recovered !== owner && !admins.includes(recovered)) {
    throw new Error(
      `signature recovers to ${recovered}, which is neither the listing wallet (${owner || 'unset'}) nor an admin`
    )
  }
  return recovered
}

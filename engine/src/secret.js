import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'

const require = createRequire(import.meta.url)
const nacl = require('./vendor/nacl.cjs') // vendored so agentcal stays zero-npm-dep

// Mobile pairing crypto — MUST stay byte-compatible with the app's
// src/lib/crypto.ts (Happy's shapes, MIT). Both ends derive the same keys
// from the shared 32-byte secret; the worker only ever relays sealed blobs.
//   key tree:  HMAC-SHA512 chain, root = HMAC(usage+' Master Seed', seed)
//   secretbox: nacl xsalsa20-poly1305, bundle = nonce(24) ‖ ciphertext
//   auth:      ed25519 keypair from deriveKey(master,'AgentCal',['auth'])
const SECRET_FILE = join(DATA_DIR, 'mobile.secret')
const te = new TextEncoder()

export function masterSecret() {
  if (existsSync(SECRET_FILE)) {
    const b = Buffer.from(readFileSync(SECRET_FILE, 'utf8').trim(), 'base64url')
    if (b.length === 32) return new Uint8Array(b)
  }
  const secret = nacl.randomBytes(32)
  writeFileSync(SECRET_FILE, Buffer.from(secret).toString('base64url') + '\n', { mode: 0o600 })
  return secret
}

// --- key tree (mirrors crypto.ts deriveKey exactly) --------------------------
const hmac512 = (key, data) => new Uint8Array(createHmac('sha512', Buffer.from(key)).update(Buffer.from(data)).digest())

function deriveRoot(seed, usage) {
  const I = hmac512(te.encode(usage + ' Master Seed'), seed)
  return { key: I.slice(0, 32), chainCode: I.slice(32) }
}
function deriveChild(chainCode, index) {
  const I = hmac512(chainCode, new Uint8Array([0x0, ...te.encode(index)]))
  return { key: I.slice(0, 32), chainCode: I.slice(32) }
}
export function deriveKey(master, usage, path) {
  let state = deriveRoot(master, usage)
  for (const index of path) state = deriveChild(state.chainCode, index)
  return state.key
}

// --- secretbox (nonce ‖ ct, JSON payloads) -----------------------------------
export function encryptSecretBox(data, secret) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const ct = nacl.secretbox(te.encode(JSON.stringify(data)), nonce, secret)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce)
  out.set(ct, nonce.length)
  return out
}
export function decryptSecretBox(bundle, secret) {
  try {
    const nonce = bundle.slice(0, nacl.secretbox.nonceLength)
    const ct = bundle.slice(nacl.secretbox.nonceLength)
    const pt = nacl.secretbox.open(ct, nonce, secret)
    return pt ? JSON.parse(new TextDecoder().decode(pt)) : null
  } catch {
    return null
  }
}

// per-machine payload key: the app decrypts hub events with this same key
export const payloadKey = (master, machineId) => deriveKey(master, 'AgentCal', ['payload', machineId])

// --- device auth (ed25519, matches crypto.ts authKeypair) --------------------
export function authKeypair(master) {
  const seed = deriveKey(master, 'AgentCal', ['auth'])
  return nacl.sign.keyPair.fromSeed(seed)
}
export function authPublicKeyB64(master) {
  return Buffer.from(authKeypair(master).publicKey).toString('base64url')
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url')

// base64url {publicKey, challenge, signature} — the desktop uses this to
// self-authenticate (e.g. registering push), the app does the same for /v1/auth
export function authChallenge(master) {
  const kp = authKeypair(master)
  const challenge = nacl.randomBytes(32)
  const signature = nacl.sign.detached(challenge, kp.secretKey)
  return { publicKey: b64url(kp.publicKey), challenge: b64url(challenge), signature: b64url(signature) }
}

// what the QR encodes; the app's parsePairingInput accepts this exact form
export const pairUrl = (master) => `agentcal://pair/${Buffer.from(master).toString('base64url')}`

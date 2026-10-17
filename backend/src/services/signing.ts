import { createHash } from 'node:crypto'

/** Poll nonces are chosen by the bridge: short, printable, no separators. */
export const NONCE = /^[A-Za-z0-9_-]{8,64}$/

export const SIGNATURE_HEADER = 'X-TraitorDash-Signature'

/**
 * Keyed SHA-256 (hex) over `token \n nonce \n body \n token`, with the server token as the secret.
 * The bridge recomputes it and applies no command unless it matches: it proves the answer comes
 * from whoever knows the token, and the nonce (fresh for every poll) stops an old answer from
 * being replayed. The secret sits at both ends, so the hash cannot be length-extended. (Not
 * HMAC proper on purpose: GMod only has a hex-string SHA-256, and HMAC needs binary strings.)
 * The bridge's copy is TraitorDash.ExpectedSignature in commands.lua; keep them identical.
 */
export function signResponse(token: string, nonce: string, body: string): string {
  return createHash('sha256').update(`${token}\n${nonce}\n${body}\n${token}`).digest('hex')
}

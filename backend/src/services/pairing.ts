import { createHash } from 'node:crypto'

/** Crockford base32: digits and letters without I, L, O, U. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_LENGTH = 10
export const CODE_TTL_MS = 10 * 60_000

/** 10 characters, 50 random bits from the system's CSPRNG. */
export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  // 256 is a multiple of 32, so taking the low 5 bits is unbiased.
  return Array.from(bytes, b => ALPHABET[b & 31]).join('')
}

/** `ABCDE-FGHJK`, the way the dashboard shows it. */
export const formatCode = (code: string) => `${code.slice(0, 5)}-${code.slice(5)}`

/** What the owner typed, as the canonical code: upper case, no dashes or spaces, O->0, I/L->1. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

/** The database holds only this. */
export const hashCode = (raw: string) => createHash('sha256').update(normalizeCode(raw)).digest('hex')

/**
 * The shapes of the names and ids the bridge and the browser send, in one place. The Lua side checks
 * the same shapes (addon/lua/traitordash/util.lua); test/validators_agree.test.ts holds both to one list.
 */

/** A role, map, language-file, weapon or source name: letters, digits and `_ . -`, 1 to 64 characters. */
export const NAME = /^[A-Za-z0-9_.-]{1,64}$/
/** A map fingerprint: SHA-256 as 64 lower-case hex characters. */
export const FINGERPRINT = /^[0-9a-f]{64}$/
/** A SteamID64 or a bot's id as the bridge reports it. */
export const STEAM_ID = /^\d{5,20}$/
/** A real SteamID64: exactly 17 digits (sign-in). */
export const STEAM_ID64 = /^\d{17}$/
/** A Workshop item id. */
export const WSID = /^\d{1,12}$/
/** A round id. */
export const ROUND_ID = /^[A-Za-z0-9-]{8,64}$/
/** A small whole number in a query string (a level, a player count). */
export const SMALL_INT = /^\d{1,3}$/

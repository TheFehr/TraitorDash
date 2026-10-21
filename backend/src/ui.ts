/**
 * Class strings the pages and the replay's browser code share. Tailwind finds a class by reading the
 * source, so a class written here is built like any other.
 */

/** A toggle button (aria-pressed turns it red): the replay and the map view. */
export const BTN = 'px-3 py-1 rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-white aria-pressed:bg-red-600 aria-pressed:border-red-500 aria-pressed:text-white transition'

/** An outlined link that sits under a heading; callers add the margins. */
export const LINK_BTN = 'inline-block px-4 py-2 rounded-lg border border-gray-700 text-sm font-bold text-gray-300 hover:text-white hover:border-red-500 transition'

/** The two looks of a tab or filter link. */
export const TAB_ON = 'bg-red-600 text-white'
export const TAB_OFF = 'bg-gray-800 border border-gray-700 text-gray-400 hover:text-white'

/** Small outlined labels. */
export const TONES = {
  red: 'border-red-500/50 text-red-400', green: 'border-green-500/50 text-green-400',
  yellow: 'border-yellow-500/50 text-yellow-400', gray: 'border-gray-600 text-gray-400',
}

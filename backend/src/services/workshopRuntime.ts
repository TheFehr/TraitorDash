import { Store } from './Store'
import { addonFetcher } from './workshop'
import { buildModel, setWorkshopKick, workshopContent } from './workshopContent'
import { kickWorkshopQueue, startWorkshopSchedule, type QueueDeps } from './workshopQueue'
import type { StockModels, StockTextures } from '../maps/propset'

// RFC 40: the pieces wired together for the running backend (the real fetcher, the game content as the stock of materials, the bridges' list of
// mounted addons). Tests build a `QueueDeps` of their own and never touch this.

let deps: QueueDeps | null = null
let stock: StockTextures | undefined
let stockModels: StockModels | undefined

/** The queue's dependencies for this process: made once, on first use. `gameStock` is the game's own materials source, for what the addons lack. */
export function workshopDeps(gameStock?: StockTextures, gameModels?: StockModels): QueueDeps {
  if (!deps) {
    const fetcher = addonFetcher()
    const content = workshopContent()
    stock = gameStock
    stockModels = gameModels
    deps = {
      fetcher,
      mounted: () => Store.getMountedAddons().ids,
      build: async path => { await buildModel(path, { fetcher, root: content.root, stock, stockModels }) },
    }
  }
  return deps
}
/** Replaces the dependencies (tests). */
export const setWorkshopDeps = (d: QueueDeps | null) => { deps = d }

/** Start-up: the run at boot and every night, and the kick that a queued model sets going. Only when WORKSHOP_COLLECTION is set. */
export function startWorkshop(gameStock?: StockTextures, gameModels?: StockModels): void {
  const d = workshopDeps(gameStock, gameModels)
  setWorkshopKick(() => kickWorkshopQueue(d, { sync: false, modelsOnly: true }))
  startWorkshopSchedule(d)
}

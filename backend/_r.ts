import * as gma from './src/maps/gma'
import * as geo from './src/services/mapgeometry'
import { readHeader } from './src/maps/bsp'
import { gameContent } from './src/services/gameContent'
import { Database } from 'bun:sqlite'
const DD = '/tmp/claude-1000/-home-phil-ttt-TraitorDash/61c490e3-1099-49dd-b650-d17deef7e9e1/scratchpad/dd/all/'
const gc = gameContent({ binary: '/tmp/claude-1000/-home-phil-ttt-TraitorDash/61c490e3-1099-49dd-b650-d17deef7e9e1/scratchpad/ddbin/DepotDownloader', root: '/tmp/claude-1000/-home-phil-ttt-TraitorDash/61c490e3-1099-49dd-b650-d17deef7e9e1/scratchpad/gc/root', scratch: '/tmp/claude-1000/-home-phil-ttt-TraitorDash/61c490e3-1099-49dd-b650-d17deef7e9e1/scratchpad/gc/scratch' })
const id = process.argv[2]!, name = process.argv[3]!
const first = await geo.fileSource(DD + id + '.gma')
const e = gma.mapEntries(await gma.readGmaIndex(first.src)).find((m: any) => m.name === name)!
await first.close()
const f = await geo.fileSource(DD + id + '.gma', e.entry.offset, e.entry.size)
const h = await readHeader(f.src)
const t0 = performance.now()
const r = await geo.buildGeometry(f.src, name, h.fingerprint, gc.models, gc.textures)
console.log(name, r.ok ? JSON.stringify(r.info) : r.error, 'note', r.ok ? r.note : '', Math.round(performance.now() - t0) + ' ms', r.ok ? (r.glb.length / 1e6).toFixed(2) + ' MB' : '')
if (r.ok) {
  await Bun.write('/tmp/claude-1000/-home-phil-ttt-TraitorDash/61c490e3-1099-49dd-b650-d17deef7e9e1/scratchpad/kzq/' + name + '.glb', r.glb)
  const db = new Database('/tmp/claude-1000/-home-phil-ttt-TraitorDash/61c490e3-1099-49dd-b650-d17deef7e9e1/scratchpad/live/work4.sqlite')
  db.query("update map_geometry set mesh = ?, info = ?, version = 9 where map_name = ?").run(r.glb, JSON.stringify(r.info), name)
  db.close()
}
await f.close()

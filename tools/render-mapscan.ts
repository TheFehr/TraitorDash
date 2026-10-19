// Turns data/traitordash/mapscan_<map>.json (from `traitordash_mapscan`) into an SVG floor plan.
//   bun tools/render-mapscan.ts mapscan_ttt_minecraft_b5.json [out.svg] [--band <zmin> <zmax>]
// Cells with a walkable surface are drawn, coloured by its height (blue low, red high); with
// --band only surfaces between the two heights. Cells with more than one floor get a dark dot;
// a cell whose only floors are crouch-only ("c" in the file) is drawn faint with a white dot.
import fs from 'node:fs'

const args = process.argv.slice(2)
const bandAt = args.indexOf('--band')
const band = bandAt >= 0 ? [Number(args[bandAt + 1]), Number(args[bandAt + 2])] : null
if (bandAt >= 0) args.splice(bandAt, 3)
const [input, output = input?.replace(/\.json$/, '') + '.svg'] = args
if (!input) { console.error('usage: bun tools/render-mapscan.ts <mapscan.json> [out.svg] [--band zmin zmax]'); process.exit(1) }

const scan = JSON.parse(fs.readFileSync(input, 'utf8'))
type Floor = { z: number, crouch: boolean }
const rows: Floor[][][] = scan.rows.map((r: string) => r.split('|').map(c => (c === '' ? [] : c.split(',').map(f => ({ z: parseInt(f), crouch: f.endsWith('c') })))))
const all = rows.flat(2).map(f => f.z)
const lo = band ? band[0] : Math.min(...all)
const hi = band ? band[1] : Math.max(...all)
const colour = (z: number) => `hsl(${Math.round(240 - 240 * ((z - lo) / Math.max(1, hi - lo)))} 70% 50%)`

const px = 8, rects: string[] = []
let minI = Infinity, maxI = -1, minJ = Infinity, maxJ = -1 // bounds of what is drawn
let floors = 0, multi = 0, crouchCells = 0
rows.forEach((row, j) => row.forEach((cell, i) => {
  const inBand = band ? cell.filter(f => f.z >= band[0] && f.z <= band[1]) : cell
  if (!inBand.length) return
  floors++
  minI = Math.min(minI, i); maxI = Math.max(maxI, i); minJ = Math.min(minJ, j); maxJ = Math.max(maxJ, j)
  // y grows north in the world and down in an SVG
  const y = (scan.ny - 1 - j) * px
  const top = inBand[inBand.length - 1]
  const onlyCrouch = inBand.every(f => f.crouch)
  if (onlyCrouch) crouchCells++
  rects.push(`<rect x="${i * px}" y="${y}" width="${px}" height="${px}" fill="${colour(top.z)}"${onlyCrouch ? ' fill-opacity=".4"' : ''}/>`)
  if (onlyCrouch) rects.push(`<rect x="${i * px + 1}" y="${y + 1}" width="2" height="2" fill="#fff"/>`)
  if (cell.length > 1) { multi++; rects.push(`<rect x="${i * px + 1}" y="${y + 1}" width="2" height="2" fill="#000" fill-opacity=".55"/>`) }
}))

// Crop to what is drawn (with a margin), so a small map in a huge world is not a few pixels.
const x0 = Math.max(0, minI - 2) * px, x1 = Math.min(scan.nx, maxI + 3) * px
const y0 = Math.max(0, scan.ny - 1 - maxJ - 2) * px, y1 = Math.min(scan.ny, scan.ny - minJ + 2) * px
fs.writeFileSync(output, `<svg xmlns="http://www.w3.org/2000/svg" width="${x1 - x0}" height="${y1 - y0}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" style="background:#111"><title>${scan.map}</title>${rects.join('')}</svg>`)
console.log(`${scan.map}: ${scan.nx}x${scan.ny} cells of ${scan.cell} units, ${scan.traces} traces, ${floors} cells with floor, ${multi} with several floors, ${crouchCells} crouch-only, heights ${lo}..${hi}. Wrote ${output}`)

import { expect, test, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import { BoxGeometry, Mesh, MeshStandardMaterial, Plane, Vector3 } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { surfacesToGlb } from '../src/maps/meshGlb'
import { lyingPlaces, prepareDecoration, prepareWater, type Painted } from '../src/sceneKit'

// RFC 33, 4.4 and 7: the decoration is a group of its own in the viewer, and a dead body in the replay does not lie on it (RFC 22, RFC 12: the floors and the solid props).

const text = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const mesh = (name: string) => { const m = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ name })); m.name = name; return m as Mesh<BoxGeometry, MeshStandardMaterial> }
const quad = (z: number) => [0, 0, z, 64, 0, z, 64, 64, z, 0, 0, z, 64, 64, z, 0, 64, z]

describe('what a body can lie on (the replay)', () => {
  test('the floors and the solid props, and nothing else: not walls, and not what is passed that is not theirs', () => {
    const floor = mesh('floor'), wall = mesh('wall'), prop = mesh('prop')
    const painted: Painted[] = [{ mesh: floor, wall: false, level: 1 }, { mesh: wall, wall: true, level: 1 }]
    expect(lyingPlaces(painted, [prop])).toEqual([floor, prop])
    expect(lyingPlaces([], [])).toEqual([])
  })

  test('a map\'s decoration is not among them: its meshes are no floor of any level, and the replay builds its list with lyingPlaces alone', async () => {
    const glb = (await surfacesToGlb({ floors: quad(0), walls: [], decoration: quad(5), decorationFaces: [0, 0], fingerprint: 'f', version: 20, revision: 1 }, { map: 'm' }))!.glb
    const model = await new Promise<any>((ok, fail) => new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '', g => ok(g.scene), fail))
    const cut = new Plane(new Vector3(0, -1, 0), 1e9)
    const decoration = prepareDecoration(model, cut)!
    expect(decoration.name).toBe('decoration')
    const decorationMeshes = new Set<unknown>(); decoration.traverse(o => { if ((o as Mesh).isMesh) decorationMeshes.add(o) })
    expect(decorationMeshes.size).toBeGreaterThan(0)
    // the way the replay makes its `painted` list: the meshes under the level nodes
    const painted: Painted[] = []
    model.traverse((o: any) => { if (/^level-\d+$/.test(o.name)) o.traverse((m: any) => { if (m.isMesh) painted.push({ mesh: m, wall: m.material.name === 'wall', level: 1 }) }) })
    expect(painted.length).toBeGreaterThan(0)
    for (const m of lyingPlaces(painted, [])) expect(decorationMeshes.has(m)).toBe(false)
    // cut like the levels, matte
    decoration.traverse((o: any) => { if (o.isMesh) { expect(o.material.clippingPlanes).toEqual([cut]); expect(o.material.metalness).toBe(0) } })
  })

  test('replay.ts: the list of what a body lies on is made by lyingPlaces and nothing else is added to it (decoration, water, movable parts, walls)', () => {
    const src = text('../src/replay.ts')
    const pushes = [...src.matchAll(/groundMeshes\.push\(([^\n]*)\)/g)].map(m => m[1]!)
    expect(pushes.length).toBe(1)
    expect(pushes[0]).toMatch(/^\.\.\.lyingPlaces\(painted, /)
    expect(pushes[0]).not.toMatch(/decoration|water|movable|wall/i)
    // no other way into the list: the one push, no assignment, no other method that adds
    expect(src.match(/groundMeshes\.(push|concat|unshift|splice)\(/g)?.length).toBe(1)
    expect(src).not.toMatch(/groundMeshes(\[[^\]]*\])? = (?!\[\])/)
    // the helper does not take decoration either
    const helper = /export function lyingPlaces\(([^)]*)\)/.exec(text('../src/sceneKit.ts'))![1]!
    expect(helper).not.toMatch(/decoration/i)
  })
})

describe('the replay and the map page switch the groups', () => {
  test('Water and Decoration of the replay use the same node as the model has, and a model without the group leaves the switch hidden', async () => {
    const src = text('../src/replay.ts')
    expect(src).toContain("el<HTMLInputElement>(root, '[data-water]')?.addEventListener('change'")
    expect(src).toContain("el<HTMLInputElement>(root, '[data-decoration]')?.addEventListener('change'")
    expect(src).toMatch(/hooks\.water = on => \{ if \(waterNode\) waterNode\.visible = on/)
    expect(src).toMatch(/hooks\.decoration = on => \{ if \(decorationNode\) decorationNode\.visible = on/)
    // the label appears (the `gone` class comes off) only for a node the model has
    expect(src).toMatch(/if \(!node \|\| !box\) continue\s*\n\s*box\.closest\('label'\)\?\.classList\.remove\('gone'\)/)
    const mapview = text('../src/mapview.ts')
    expect(mapview).toMatch(/\[data-decoration\]'\)\?\.addEventListener\('change', e => \{\s*\n\s*if \(decoration\) decoration\.visible = /)
    expect(mapview).toContain('decoration = prepareDecoration(model, cut)')
  })

  test('prepareWater and prepareDecoration find their node by name, and are null for a model without it', async () => {
    const glb = (await surfacesToGlb({ floors: quad(0), walls: [], water: quad(2), fingerprint: 'f', version: 20, revision: 1 }, { map: 'm' }))!.glb
    const model = await new Promise<any>((ok, fail) => new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '', g => ok(g.scene), fail))
    const cut = new Plane(new Vector3(0, -1, 0), 1e9)
    expect(prepareDecoration(model, cut)).toBeNull()
    expect(prepareWater(model, cut)?.name).toBe('water')
  })
})

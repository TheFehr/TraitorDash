import { expect, test } from 'bun:test'
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three'
import { heightColours, type Painted } from '../src/sceneKit'

// The Height colouring tints a surface by its height. It once did nothing: the surface's colour was copied over the tint
// before the two were mixed, so every vertex came out as the plain colour.

const mesh = (zs: number[], wall = false): Painted => {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(zs.flatMap((z, i) => [i, 0, z])), 3))
  return { mesh: new Mesh(g, new MeshStandardMaterial()), wall, level: 1 }
}
const colour = (p: Painted, i: number) => { const a = p.mesh.geometry.getAttribute('color'); return [a.getX(i), a.getY(i), a.getZ(i)] }

test('a low vertex and a high vertex get different colours, and neither is the plain colour', async () => {
  const p = mesh([0, 100, 200, 300, 400])
  heightColours([p])
  expect(colour(p, 0)).not.toEqual(colour(p, 4))
  expect(colour(p, 0)[2]).toBeGreaterThan(colour(p, 4)[2]!) // the low end is blue, the high end yellow
  const { Color } = await import('three'); const plain = new Color(0xcfc6b0)
  expect(colour(p, 0)).not.toEqual([plain.r, plain.g, plain.b]); expect(colour(p, 4)).not.toEqual([plain.r, plain.g, plain.b])
})

test('equal heights in two meshes give equal colours; a wall is darker than a floor at the same height', () => {
  const a = mesh([0, 100]), b = mesh([0, 100]), w = mesh([0, 100], true)
  heightColours([a, b, w])
  expect(colour(a, 1)).toEqual(colour(b, 1))
  expect(colour(w, 1)[0]).toBeLessThan(colour(a, 1)[0]!)
})

test('one spire does not squeeze the rest of the map into a single colour', () => {
  const ground = Array.from({ length: 200 }, (_, i) => i) // 0..199
  const p = mesh([...ground, 100000])
  heightColours([p])
  expect(colour(p, 0)).not.toEqual(colour(p, 199))
})

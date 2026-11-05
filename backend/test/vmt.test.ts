import { expect, test, describe } from 'bun:test'
import { applyPatch, parseMaterial, parseSeeThrough, patchOf } from '../src/maps/vmt'

// RFC 18, 5: what a material file says that drawing needs: the texture, and whether it is cut out, see-through or added.

describe('a material', () => {
  test('names its texture (in any way of writing it), and is solid when nothing says otherwise', () => {
    expect(parseMaterial('"LightmappedGeneric"\n{\n\t"$basetexture" "Brick\\Brickfloor001A"\n}')).toMatchObject({ texture: 'brick/brickfloor001a', kind: 'solid', alpha: 1, additive: false })
    expect(parseMaterial('LightmappedGeneric { $basetexture nature/blendgrass002 }').texture).toBe('nature/blendgrass002')
    expect(parseMaterial('"X" { "$baseTexture" "a/b.vtf" }').texture).toBe('a/b') // the case of the key, and an extension
    expect(parseMaterial('"X" { "$surfaceprop" "glass" }').texture).toBeNull()
  })
  test('is cut out by $alphatest, see-through by $translucent, added by $additive; the first wins over the second', () => {
    expect(parseMaterial('"X" { "$basetexture" "a" "$alphatest" 1 }').kind).toBe('mask')
    expect(parseMaterial('"X" { "$basetexture" "a" "$translucent" "1" }').kind).toBe('blend')
    expect(parseMaterial('"X" { "$basetexture" "a" "$translucent" 1 "$alphatest" 1 }').kind).toBe('mask')
    expect(parseMaterial('"X" { "$basetexture" "a" "$additive" 1 }')).toMatchObject({ kind: 'blend', additive: true })
    expect(parseMaterial('"X" { "$basetexture" "a" "$alphatest" 0 }').kind).toBe('solid')
    expect(parseMaterial('"X" { "$basetexture" "a" "$translucent" 1 "$alpha" 0.25 }')).toMatchObject({ alpha: 0.25, explicitAlpha: true })
    expect(parseMaterial('"X" { "$basetexture" "a" "$translucent" 1 "$alpha" 9 }')).toMatchObject({ alpha: 1, explicitAlpha: false })
  })
  test('a texture name with anything but a path in it is no texture', () => {
    for (const bad of ['../../etc/passwd', 'a;b', 'x'.repeat(300)]) expect(parseMaterial(`"X" { "$basetexture" "${bad}" }`).texture).toBeNull()
  })
  test('parseSeeThrough is the material when it is not solid, else null', () => {
    expect(parseSeeThrough('"X" { "$basetexture" "a" }')).toBeNull()
    expect(parseSeeThrough('"X" { "$basetexture" "a" "$alphatest" 1 }')).toMatchObject({ kind: 'mask' })
  })
})

describe('a patch (the material a map makes for a cubemap)', () => {
  const patch = '"Patch"\n{\n\t"include" "materials\\Brick\\Wall01.vmt"\n\t"insert"\n\t{\n\t\t"$envmap" "env_cubemap"\n\t\t"$basetexture" "brick/wall01_b"\n\t}\n}'
  test('says which material it includes; one that is not a patch includes none', () => {
    expect(patchOf(patch)).toBe('materials/brick/wall01.vmt')
    expect(patchOf('"LightmappedGeneric" { "$basetexture" "a" }')).toBeNull()
    expect(patchOf('"Patch" { "include" "../../etc/passwd.vmt" }')).toBeNull()
    expect(patchOf('"Patch" { "include" "materials/a;b.vmt" }')).toBeNull()
  })
  test('is laid over the included material: what it inserts or replaces wins', () => {
    const merged = applyPatch('"LightmappedGeneric"\n{\n\t"$basetexture" "brick/wall01"\n\t"$surfaceprop" "brick"\n}', patch)
    expect(parseMaterial(merged)).toMatchObject({ texture: 'brick/wall01_b' })
    expect(applyPatch('"X" { "$basetexture" "a" }', '"Patch" { "include" "materials/a.vmt" }')).toContain('"$basetexture" "a"') // nothing inserted: the included stays
    expect(parseMaterial(applyPatch('"X" { "$basetexture" "a" }', '"Patch" { "include" "materials/a.vmt" "replace" { "$translucent" 1 } }')).kind).toBe('blend')
  })
})

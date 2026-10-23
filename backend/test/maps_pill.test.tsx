import { expect, test } from 'bun:test'
process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret-0'
const { MapsPage } = await import('../src/components/MapPages')

// An admin's 3D view and floor plan are one page, so a map that has both shows one pill, not two links to the same place.
const maps = ['ttt_both', 'ttt_plan', 'ttt_mesh'].map(name => ({
  name, size: 1, fingerprint: 'f', matchesGamemode: true, inCycle: false, onCooldown: false, isCurrent: false, inVotePool: true, votable: true,
}))
const state = { current: null, next: null, gamemode: 'terrortown', pattern: '^ttt_', poolBasis: 'prefixes', configSource: 'merged', voteAddon: true, reportedAt: '2026-10-23T10:00:00Z' }
const render = (admin: boolean) => String(
  <MapsPage
    ctx={{ embed: false, viewer: { steamId: '1', admin }, browser: null, signinOpen: false, now: Date.parse('2026-10-23T10:00:00Z') } as any}
    server={{ id: 's', name: 'S' }} state={state as any} maps={maps as any} activity={new Map()}
    plans={admin ? [{ map: 'ttt_both', fingerprint: 'f' }, { map: 'ttt_plan', fingerprint: 'f' }] as any : undefined}
    meshes={new Set(['ttt_both', 'ttt_mesh'])}
  />)
const row = (html: string, name: string) => html.split('<div class="f card"').slice(1).find(r => r.includes(`>${name}</span>`))!

test('an admin sees one pill for a map with a 3D view and a floor plan', () => {
  const html = render(true)
  expect(row(html, 'ttt_both')).toContain('3D · Floor plan')
  expect(row(html, 'ttt_both').match(/<a [^>]*class="pill/g)?.length).toBe(1)
  expect(row(html, 'ttt_plan')).toContain('>Floor plan<')
  expect(row(html, 'ttt_plan')).not.toContain('3D')
  expect(row(html, 'ttt_mesh')).toContain('>3D<')
  expect(row(html, 'ttt_mesh')).not.toContain('Floor plan')
})

test('a user who is not an admin sees only the 3D pill', () => {
  const html = render(false)
  expect(row(html, 'ttt_both')).toContain('>3D<')
  expect(row(html, 'ttt_both')).not.toContain('Floor plan')
})

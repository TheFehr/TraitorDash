import { expect, test, describe, beforeAll } from 'bun:test'
import { serializeSigned } from 'hono/utils/cookie'

const SECRET = 'test-secret-test-secret-test-secret-0'
process.env.TRAITORDASH_DB = ':memory:'
process.env.SESSION_SECRET = SECRET
process.env.ADMIN_STEAM_IDS = '76561198000000000'

import { configureVoice } from '../src/services/voice'

// The head of every page of a server is made by one component (PageHead in components/CaseFile.tsx): the way back, the site's sections, then the
// page's title. The owner had four screenshots side by side: Roles and Voice put the section buttons before the title, Round stats and Maps after
// it, one crumb line was a link and a word, another the server's name, another "name / Roles". These tests keep it one way.

const ADMIN = '76561198000000000'
let app: any, server: { id: string, name: string }
const get = async (path: string) => app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: (await serializeSigned('steam_id', ADMIN, SECRET)).split(';')[0]! } }))

beforeAll(async () => {
  app = (await import('../src/index')).app
  const Store = (await import('../src/services/Store')).Store
  server = { ...(Store.addServer('Head Test Server') as any), name: 'Head Test Server' }
  configureVoice({ url: 'wss://lk.test', apiUrl: 'https://lk.test', key: 'devkey', secret: 'devsecret-devsecret-devsecret-00' })
})

describe('the head of a section page: the same four times', () => {
  const sections = [
    { path: () => `/servers/${server.id}/stats`, label: 'Round stats' },
    { path: () => `/servers/${server.id}/maps`, label: 'Maps' },
    { path: () => `/servers/${server.id}/roles`, label: 'Roles' },
    { path: () => `/servers/${server.id}/voice`, label: 'Voice' },
  ]

  test('crumbs, then the section buttons, then the title, on every one', async () => {
    for (const s of sections) {
      const html = await (await get(s.path())).text()
      const crumbs = html.indexOf('class="crumbs"'), nav = html.indexOf('class="sections"'), h1 = html.indexOf('<h1')
      expect(crumbs, s.label).toBeGreaterThan(-1)
      expect(nav, s.label + ': the section buttons come after the way back').toBeGreaterThan(crumbs)
      expect(h1, s.label + ': and before the title').toBeGreaterThan(nav)
    }
  })

  test('the way back is the server\'s name, as text, on every one (not a link, not "name / Roles")', async () => {
    for (const s of sections) {
      const html = await (await get(s.path())).text()
      // the text straight after the opening tag, up to the next tag: a link or a "/ Roles" after the name would not be the whole of it
      const at = html.indexOf('class="crumbs"')
      const crumbs = /^class="crumbs"[^>]*>([^<]*)(<\/div>)?/.exec(html.slice(at))
      expect(crumbs?.[1], s.label).toBe(server.name)
      expect(crumbs?.[2], s.label + ': nothing but the name').toBe('</div>')
    }
  })

  test('the button of the page that is open is marked, and only that one', async () => {
    for (const s of sections) {
      const html = await (await get(s.path())).text()
      const nav = /<nav class="sections"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? ''
      const current = [...nav.matchAll(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/g)].map(m => m[1]!)
      expect(current.length, s.label).toBe(1)
      expect(current[0], s.label).toContain(s.label)
    }
  })
})

describe('nothing composes a head by hand', () => {
  test('the section buttons are made by PageHead alone (and by the two list pages of servers, which have no title of their own)', async () => {
    const glob = new Bun.Glob('*.tsx')
    const dir = new URL('../src/components/', import.meta.url).pathname
    const users: string[] = []
    for await (const f of glob.scan(dir)) {
      const text = await Bun.file(dir + f).text()
      if (/<Sections\b/.test(text)) users.push(f)
    }
    expect(users.sort()).toEqual(['CaseFile.tsx', 'HomePage.tsx', 'ServerDashboard.tsx'])
  })

  test('the way back of a page below a section starts with the link to its list, like the others ("Rounds / ...", "All maps / ...", "All roles / ..."): never the server\'s name', async () => {
    // The player page had "Server name / Round stats", the pattern of a section's own page, among pages that all begin with their list.
    const dir = new URL('../src/components/', import.meta.url).pathname
    const seen: string[] = []
    for (const f of ['StatsPages.tsx', 'MapPages.tsx', 'RolePublic.tsx', 'ReplayPage.tsx', 'VoicePage.tsx']) {
      const text = await Bun.file(dir + f).text()
      for (const m of text.matchAll(/crumbs=\{(.{0,28})/g)) {
        const start = m[1]!
        const sectionPage = start.startsWith('<ServerName') || start.startsWith('server.name')
        const wayBack = start.startsWith('<><a href=')
        expect(sectionPage || wayBack, `${f}: crumbs={${start}`).toBe(true)
        seen.push(f + ':' + (sectionPage ? 'section' : 'way back'))
      }
    }
    expect(seen.filter(s => s.endsWith('section')).length).toBe(4) // Round stats, Maps, Roles, Voice
    expect(seen.filter(s => s.endsWith('way back')).length).toBe(6) // round, player, map, a map's rounds, role, replay
  })

  test('every page of a server with a way back and a title uses PageHead', async () => {
    const dir = new URL('../src/components/', import.meta.url).pathname
    for (const f of ['StatsPages.tsx', 'MapPages.tsx', 'RolePublic.tsx', 'ReplayPage.tsx', 'VoicePage.tsx']) {
      const text = await Bun.file(dir + f).text()
      expect(text, f).toContain('<PageHead')
      expect(text, f + ' has its own crumbs line next to PageHead').not.toMatch(/<Crumbs>|class="crumbs"/)
    }
  })
})

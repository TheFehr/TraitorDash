import { expect, test, describe } from 'bun:test'
import { Heartbeat } from '../src/components/Heartbeat'
import { AdminDashboard } from '../src/components/AdminDashboard'
import { HomePage } from '../src/components/HomePage'
import { ServerDashboard } from '../src/components/ServerDashboard'
import { ServerManager } from '../src/components/ServerManager'

const seen = '2026-10-16T15:39:44.000Z'
const server = { id: 's1', name: 'DRAI', last_seen: seen }
const never = { id: 's2', name: 'Fresh', last_seen: null }

describe('last heartbeat', () => {
  test('is a <time> carrying the UTC instant, so the browser can show the viewer\'s timezone', () => {
    const out = String(<Heartbeat lastSeen={seen} />)
    expect(out).toContain('datetime="2026-10-16T15:39:44.000Z"')
    expect(out).toContain('x-text="new Date($el.getAttribute(&#39;datetime&#39;)).toLocaleString()"')
  })

  test('says Never for a server that has not reported, and survives garbage', () => {
    expect(String(<Heartbeat lastSeen={null} />)).toContain('Never')
    expect(String(<Heartbeat lastSeen="not a date" />)).toContain('Invalid Date')
  })

  test('shown for admins, not only for guests', () => {
    expect(String(<AdminDashboard servers={[server]} />)).toContain('datetime="2026-10-16T15:39:44.000Z"')
    expect(String(<ServerDashboard server={server} roles={[]} />)).toContain('Last heartbeat')
    expect(String(<ServerManager servers={[server]} />)).toContain('datetime="2026-10-16T15:39:44.000Z"')
  })

  test('the front page does not show a server\'s internal id', () => {
    expect(String(<HomePage ctx={{ embed: false, viewer: null }} servers={[server]} />)).not.toContain('>s1<')
  })

  test('still shown for guests, and a never-seen server reads Never everywhere', () => {
    expect(String(<HomePage ctx={{ embed: false, viewer: null }} servers={[server]} />)).toContain('datetime="2026-10-16T15:39:44.000Z"')
    expect(String(<AdminDashboard servers={[never]} />)).toContain('Never')
  })
})

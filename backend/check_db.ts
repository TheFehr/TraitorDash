import { Database } from 'bun:sqlite'
const db = new Database('traitordash.sqlite')

const servers = db.prepare('SELECT id, name, last_seen, api_token FROM servers').all()
console.log('--- Servers Table ---')
console.table(servers)

const roles = db.prepare('SELECT server_id, role_name, updated_at FROM roles').all()
console.log('--- Roles Table ---')
console.table(roles)

const commands = db.prepare('SELECT * FROM commands').all()
console.log('--- Pending Commands ---')
console.table(commands)

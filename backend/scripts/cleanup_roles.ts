import { Database } from 'bun:sqlite'

const db = new Database('traitordash.sqlite')

const rolesToKeep = [
  'innocent', 'mesmerist', 'haunted', 'zombie', 'vampire', 'revolutionary', 
  'traitor', 'spy', 'necromancer', 'thrall', 'survivalist', 'deputy', 
  'announcer', 'medic', 'swapper', 'spectre', 'sidekick', 'infected', 
  'cupid', 'detective', 'hitman', 'sheriff', 'defector', 'jackal', 
  'arsonist', 'rat'
]

const placeholders = rolesToKeep.map(() => '?').join(',')
const result = db.run(`DELETE FROM roles WHERE role_name NOT IN (${placeholders})`, rolesToKeep)

console.log(`Successfully deleted ${result.changes} stale/test roles.`)
db.close()

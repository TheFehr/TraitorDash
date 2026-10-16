import { Database } from 'bun:sqlite'
import { migrate } from './migrations'

const db = new Database(process.env.TRAITORDASH_DB || 'traitordash.sqlite', { create: true })

migrate(db)

export default db

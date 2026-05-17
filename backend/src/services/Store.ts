import db from './Database'

export class Store {
  static getServers(): any[] {
    const query = db.prepare('SELECT * FROM servers ORDER BY name ASC')
    return query.all()
  }

  static getServerById(id: string): any | null {
    const query = db.prepare('SELECT * FROM servers WHERE id = ?')
    return query.get(id) || null
  }

  static getServerByToken(token: string): any | null {
    const query = db.prepare('SELECT * FROM servers WHERE api_token = ?')
    return query.get(token) || null
  }

  static addServer(name: string) {
    const id = crypto.randomUUID()
    const token = crypto.randomUUID()
    const insert = db.prepare('INSERT INTO servers (id, name, api_token) VALUES (?, ?, ?)')
    insert.run(id, name, token)
    return { id, token }
  }

  static deleteServer(id: string) {
    db.run('DELETE FROM roles WHERE server_id = ?', [id])
    db.run('DELETE FROM commands WHERE server_id = ?', [id])
    db.run('DELETE FROM servers WHERE id = ?', [id])
  }

  static updateHeartbeat(serverId: string) {
    const update = db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?')
    update.run(new Date().toISOString(), serverId)
  }

  static getRoleHash(serverId: string, roleName: string): string | null {
    const query = db.prepare('SELECT md5_hash FROM roles WHERE server_id = ? AND role_name = ?')
    const row = query.get(serverId, roleName) as { md5_hash: string } | null
    return row ? row.md5_hash : null
  }

  static saveSchema(serverId: string, roleName: string, team: string, isPolicing: boolean, baserole: number, schema: any[], md5Hash?: string) {
    this.updateHeartbeat(serverId)
    const upsert = db.prepare(`
      INSERT INTO roles (server_id, role_name, team, is_policing, baserole, schema_json, md5_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, role_name) DO UPDATE SET
        team = excluded.team,
        is_policing = excluded.is_policing,
        baserole = excluded.baserole,
        schema_json = excluded.schema_json,
        md5_hash = excluded.md5_hash,
        updated_at = excluded.updated_at
    `)
    const now = new Date().toISOString()
    upsert.run(serverId, roleName, team, isPolicing ? 1 : 0, baserole, JSON.stringify(schema), md5Hash || null, now)
  }

  static getRoles(serverId: string): any[] {
    const query = db.prepare('SELECT role_name, team, is_policing, baserole FROM roles WHERE server_id = ? ORDER BY team ASC, role_name ASC')
    return query.all(serverId)
  }

  static getSchema(serverId: string, roleName: string): any[] | null {
    const query = db.prepare('SELECT schema_json FROM roles WHERE server_id = ? AND role_name = ?')
    const row = query.get(serverId, roleName) as { schema_json: string } | null
    return row ? JSON.parse(row.schema_json) : null
  }

  static stageCommand(serverId: string, command: string, args: string) {
    const insert = db.prepare('INSERT INTO commands (server_id, command, args) VALUES (?, ?, ?)')
    insert.run(serverId, command, args)
  }

  static pollCommands(serverId: string): any[] {
    const query = db.prepare('SELECT id, command, args FROM commands WHERE server_id = ? ORDER BY staged_at ASC')
    const rows = query.all(serverId) as any[]

    if (rows.length > 0) {
      // Clear polled commands
      const ids = rows.map(r => r.id).join(',')
      db.run(`DELETE FROM commands WHERE id IN (${ids})`)
    }

    return rows
  }
}

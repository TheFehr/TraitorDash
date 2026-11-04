// The bridge sends the class name of what did the damage: weapon_ttt_m16, weapon_zm_shotgun, prop_physics. A player
// reads "M16"; pages show a name made from it and keep the class as a tooltip (RFC 21, 4.3).

const KNOWN: Record<string, string> = {
  weapon_zm_improvised: 'Crowbar', weapon_zm_mac10: 'MAC10', weapon_zm_rifle: 'Scout', weapon_zm_revolver: 'Deagle',
  weapon_zm_pistol: 'Pistol', weapon_zm_shotgun: 'Shotgun', weapon_zm_sledge: 'H.U.G.E-249', weapon_ttt_m16: 'M16',
  weapon_ttt_glock: 'Glock', weapon_ttt_knife: 'Knife', weapon_ttt_flaregun: 'Flare gun', weapon_ttt_c4: 'C4',
  ttt_c4: 'C4', weapon_ttt_push: 'Newton launcher', weapon_ttt_sipistol: 'Silenced pistol', weapon_ttt_unarmed: 'Fists',
  weapon_ttt_confgrenade: 'Discombobulator', weapon_ttt_smokegrenade: 'Smoke grenade', weapon_ttt_decoy: 'Decoy',
  weapon_ttt_teleport: 'Teleporter', weapon_ttt_health_station: 'Health station', weapon_ttt_radio: 'Radio',
  worldspawn: 'The world (falls and traps)', prop_physics: 'A thrown prop', prop_physics_multiplayer: 'A thrown prop',
  entityflame: 'Fire', env_explosion: 'An explosion', trigger_hurt: 'A trap', player: 'Fists',
}

const PREFIX = /^(weapon_ttt2_|weapon_ttt_|weapon_zm_|weapon_|ttt_)/

/** "M16" from "weapon_ttt_m16"; a class nobody named gets its words, capitalised; null stays "Unknown". */
export function weaponName(cls: string | null | undefined): string {
  if (!cls) return 'Unknown'
  const known = KNOWN[cls]
  if (known) return known
  const words = cls.replace(PREFIX, '').split(/[_.-]+/).filter(Boolean)
  if (words.length === 0) return cls
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

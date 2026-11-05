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
  entityflame: 'Fire', env_fire: 'Fire', env_explosion: 'Explosion', trigger_hurt: 'A trap', point_hurt: 'A trap', player: 'Fists',
  ttt_fraggrenade_proj: 'Frag grenade', weapon_ttt_sawedoff: 'Sawed-off', weapon_ttt_homebat: 'Home-run bat', weapon_ttt_melonmine: 'Melon mine',
  func_physbox: 'A thrown prop', weapon_ttt_m4a1_s: 'M4A1-S', weapon_ttth_zombpistol: 'Zombie pistol',
}

// the packs of weapons have a tag of two letters (weapon_sp_striker, weapon_rp_railgun), and some are `swep_` or `nc_ttt_`
const PREFIX = /^(weapon_ttt2_|weapon_ttt_|weapon_zm_|weapon_[a-z]{2}_|swep_|nc_ttt_|ttt_)/
/** Words that are letters of a gun's model, not words. */
const ACRONYMS = new Set(['awp', 'aug', 'ak', 'fn', 'fal', 'smg', 'sg', 'mp', 'ar', 'lmg', 'tmp', 'p90', 'ump'])
const word = (w: string) => (/\d/.test(w) || ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w)

/** "M16" from "weapon_ttt_m16"; a class nobody named gets its words, capitalised; null stays "Unknown". */
export function weaponName(cls: string | null | undefined): string {
  if (!cls) return 'Unknown'
  const known = KNOWN[cls]
  if (known) return known
  const words = cls.replace(PREFIX, '').split(/[_.-]+/).filter(Boolean).filter((w, i, all) => !(i === all.length - 1 && all.length > 1 && /^(proj|projectile)$/i.test(w)))
  if (words.length === 0) return cls
  const text = words.map(word).join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

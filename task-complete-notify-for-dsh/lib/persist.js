/**
 * task-complete-notify-for-dsh — user-layer config persistence.
 *
 * Reads / merges / writes this plugin's config row in the profile's user layer
 * (`cordis.patch.yml`). This lets runtime commands (e.g. /notify-threshold) make
 * changes that survive a restart, following dsh's convention: user overrides
 * live in the profile patch file, applied last.
 *
 * The patch file is a top-level YAML array of loader patch entries. Each entry
 * is either a plain `{ id, name?, config? }` row (a config override) or a
 * structured patch op (`insert`, `disable`, ...). We only ever touch the plain
 * row whose `id` matches ours; we never rewrite unrelated entries.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const PLUGIN_ID = 'task-complete-notify'

/** Resolve the profile user layer path from the dsh process args. */
export function profileDir() {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  const profile = flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-') ? argv[flag + 1] : 'web'
  // DSH_HOME already points at the .dsh data dir; otherwise it is under $HOME.
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.length > 0)
    ? process.env.DSH_HOME
    : join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
  return join(home, 'profiles', profile)
}

/** The user layer patch file path. */
export function patchFile() {
  return join(profileDir(), 'cordis.patch.yml')
}

/**
 * Read the current config row for this plugin from the user layer.
 * @returns the row's `config` object (may be empty), or null if no row exists.
 */
export function readConfig() {
  const file = patchFile()
  let root = []
  try {
    const doc = YAML.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(doc)) root = doc
  } catch {
    return null // unreadable / invalid — caller decides fallback
  }
  for (const entry of root) {
    if (entry && typeof entry === 'object' && entry.id === PLUGIN_ID && !entry.insert) {
      return entry.config && typeof entry.config === 'object' ? entry.config : {}
    }
  }
  return null
}

/**
 * Merge new keys into this plugin's config row in the user layer and write the
 * file back. Preserves all other entries and the row's other keys. Creates the
 * row if absent; writes an explicit `[]` if nothing remains after removal.
 * @param updates - config keys to set (full replacement per key).
 * @param removes - config keys to delete (from the row only).
 * @returns true on success, false on any failure (bad file, no permission).
 */
export function writeConfig(updates = {}, removes = []) {
  const file = patchFile()
  let root = []
  try {
    const doc = YAML.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(doc)) root = doc
  } catch {
    root = [] // unreadable/invalid — start from an empty user layer
  }

  // Remove any existing row for us so we rebuild it cleanly.
  const rest = root.filter((entry) => !(entry && typeof entry === 'object' && entry.id === PLUGIN_ID && !entry.insert))
  let row = null
  for (const entry of root) {
    if (entry && typeof entry === 'object' && entry.id === PLUGIN_ID && !entry.insert) row = entry
  }
  if (!row) row = { id: PLUGIN_ID }
  if (typeof row.config !== 'object' || row.config === null) row.config = {}

  for (const key of removes) delete row.config[key]
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') delete row.config[key]
    else row.config[key] = value
  }

  // If our row now has no config keys, drop it entirely (restore clean state).
  if (Object.keys(row.config).length === 0) {
    // keep `rest` (row already excluded from it) — nothing to append
  } else {
    rest.push(row)
  }

  try {
    // YAML block style, no document markers, trailing newline — matches dsh style.
    const text = rest.length === 0 ? '[]\n' : `${YAML.stringify(rest, { indent: 2 })}\n`
    writeFileSync(file, text, 'utf8')
    return true
  } catch {
    return false
  }
}

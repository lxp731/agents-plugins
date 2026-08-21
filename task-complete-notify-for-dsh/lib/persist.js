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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import YAML from 'yaml'

export const PLUGIN_ID = 'task-complete-notify'

/**
 * Resolve the active profile name, most authoritative first:
 *  1. an explicit profile (passed by the caller, e.g. from ctx/config)
 *  2. the DSH_PROFILE environment variable
 *  3. `--profile <name>` from the process argv (the dsh launcher's own arg)
 *  4. fallback `'web'` (the common default / `dsh web` alias)
 *
 * This is more robust than reading argv alone: argv parsing can be wrong when
 * the plugin runs in a context whose argv doesn't carry `--profile`.
 * @param explicit - a caller-provided profile name, if any.
 * @returns the resolved profile name (never empty).
 */
export function resolveProfile(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const env = process.env.DSH_PROFILE
  if (typeof env === 'string' && env.length > 0) return env
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) {
    return argv[flag + 1]
  }
  return 'web'
}

/**
 * Resolve the profile user-layer directory.
 * @param explicit - optional profile name override (see {@link resolveProfile}).
 */
export function profileDir(explicit) {
  const profile = resolveProfile(explicit)
  // DSH_HOME already points at the .dsh data dir; otherwise it is under $HOME.
  const home = (process.env.DSH_HOME && process.env.DSH_HOME.length > 0)
    ? process.env.DSH_HOME
    : join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
  return join(home, 'profiles', profile)
}

/**
 * The user-layer patch file path.
 * @param explicit - optional profile name override.
 */
export function patchFile(explicit) {
  return join(profileDir(explicit), 'cordis.patch.yml')
}

/**
 * Read the current config row for this plugin from the user layer.
 * @param explicit - optional profile name override.
 * @returns the row's `config` object (may be empty), or null if no row exists.
 */
export function readConfig(explicit) {
  const file = patchFile(explicit)
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
 * @param explicit - optional profile name override.
 * @returns true on success, false on any failure (bad file, no permission).
 */
export function writeConfig(updates = {}, removes = [], explicit) {
  const file = patchFile(explicit)
  let root = []
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    raw = '' // file absent — treat as an empty user layer and create it
  }
  if (raw.trim().length > 0) {
    try {
      const doc = YAML.parse(raw)
      // Only accept a real array; anything else (null, scalar, map) means the
      // file isn't a valid patch list — abort rather than risk clobbering it.
      if (!Array.isArray(doc)) return false
      root = doc
    } catch {
      // Present but unparseable — never overwrite with a destructive empty array.
      return false
    }
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
    // Ensure the profile dir exists (a freshly created/partial profile may not
    // have it yet); then write YAML block style, no document markers, trailing
    // newline — matches dsh style.
    mkdirSync(dirname(file), { recursive: true })
    const text = rest.length === 0 ? '[]\n' : `${YAML.stringify(rest, { indent: 2 })}\n`
    writeFileSync(file, text, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * task-complete-notify-for-dsh — user-layer config persistence.
 *
 * Reads / merges / writes this plugin's config row in the profile's user layer
 * (`cordis.patch.yml`). This lets runtime commands (e.g. /notify-threshold) make
 * changes that survive a restart, following dsh's convention: user overrides
 * live in the profile patch file, applied last.
 *
 * Robustness guarantees:
 *  - **Comments are preserved**: edits go through the `yaml` Document AST, so
 *    comments and formatting around untouched entries survive a write.
 *  - **Atomic writes**: content is written to a temp file and renamed into
 *    place, so a crash mid-write can never leave a torn YAML file.
 *  - **Cross-process lock**: a best-effort lockfile serializes writers for up
 *    to ~2s (stale locks older than 5s are taken over; after that we proceed
 *    unlocked rather than fail the command).
 *  - **Never clobbers**: a patch file that parses but isn't a top-level array,
 *    or that fails to parse at all, aborts the write instead of being wiped.
 *
 * The patch file is a top-level YAML array of loader patch entries. Each entry
 * is either a plain `{ id, name?, config? }` row (a config override) or a
 * structured patch op (`insert`, `disable`, ...). We only ever touch the plain
 * row whose `id` matches ours; we never rewrite unrelated entries.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSeq, parseDocument, stringify, Document } from 'yaml'

export const PLUGIN_ID = 'task-complete-notify'

/**
 * Resolve the active profile AND how it was determined, most authoritative
 * first: an explicit argument, the DSH_PROFILE environment variable, argv
 * `--profile <name>`, then a `'web'` fallback.
 *
 * Exporting the source lets callers warn when they had to fall back (silently
 * writing into the wrong profile would be hard to debug).
 * @param explicit - a caller-provided profile name, if any.
 * @returns { profile, source } with source ∈ 'explicit' | 'env' | 'argv' | 'fallback'.
 */
export function resolveProfileDetailed(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return { profile: explicit, source: 'explicit' }
  const env = process.env.DSH_PROFILE
  if (typeof env === 'string' && env.length > 0) return { profile: env, source: 'env' }
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) {
    return { profile: argv[flag + 1], source: 'argv' }
  }
  return { profile: 'web', source: 'fallback' }
}

/** Resolve the active profile name only (see {@link resolveProfileDetailed}). */
export function resolveProfile(explicit) {
  return resolveProfileDetailed(explicit).profile
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

/** Find the index of OUR plain config row within a parsed sequence, or -1. */
function rowIndex(items) {
  for (let i = 0; i < items.length; i++) {
    const entry = items[i]
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === PLUGIN_ID && entry.insert == null) {
      return i
    }
  }
  return -1
}

/**
 * Read the current config row for this plugin from the user layer.
 * @param explicit - optional profile name override.
 * @returns the row's `config` object (may be empty), or null if no row exists.
 */
export function readConfig(explicit) {
  const file = patchFile(explicit)
  let root
  try {
    const doc = parseDocument(readFileSync(file, 'utf8'))
    if (doc.errors.length > 0) return null
    root = (!doc.contents || !isSeq(doc.contents)) ? [] : doc.contents.items.map((n) => n.toJSON())
  } catch {
    return null // unreadable / invalid — caller decides fallback
  }
  const idx = rowIndex(root)
  if (idx === -1) return null
  const cfg = root[idx].config
  return cfg && typeof cfg === 'object' ? cfg : {}
}

// --- locking & atomic write --------------------------------------------------

const LOCK_STALE_MS = 5_000
const LOCK_TIMEOUT_MS = 2_000

/** Synchronous ~ms sleep that works on any thread. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // Fallback (should not happen under Node): brief busy-wait.
    const until = Date.now() + ms
    while (Date.now() < until) { /* spin */ }
  }
}

/**
 * Best-effort exclusive lock around the patch file. Creates `<file>.lock`
 * exclusively; waits up to LOCK_TIMEOUT_MS for other writers, takes over locks
 * older than LOCK_STALE_MS, and always proceeds (unlocked) after that so a
 * wedged lock can never permanently break /notify-threshold.
 * @returns an unlock function (idempotent).
 */
function lockPatchFile(file) {
  const lockPath = `${file}.lock`
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      writeFileSync(lockPath, String(Date.now()), { flag: 'wx' })
      let released = false
      return () => {
        if (released) return
        released = true
        try { unlinkSync(lockPath) } catch { /* already gone */ }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') break // e.g. EPERM — proceed unlocked
      let ts
      try { ts = Number(readFileSync(lockPath, 'utf8')) || 0 } catch { ts = LOCK_STALE_MS + 1 }
      const age = ts > 0 ? Date.now() - ts : LOCK_STALE_MS + 1
      if (age > LOCK_STALE_MS) {
        try { unlinkSync(lockPath) } catch { /* raced away */ }
        continue // immediately retry to take over the stale lock
      }
      if (Date.now() >= deadline) break // timed out — proceed unlocked rather than fail
      sleepSync(50)
    }
  }
  return () => {}
}

/** Write atomically: temp file in the same directory, then rename over target. */
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/**
 * Merge new keys into this plugin's config row in the user layer and write the
 * file back. Preserves unrelated entries, their comments, and the row's other
 * keys (via the YAML Document AST). Creates the row if absent; drops the row
 * entirely when its config becomes empty (restore clean state).
 * @param updates - config keys to set (full replacement per key).
 * @param removes - config keys to delete (from the row only).
 * @param explicit - optional profile name override.
 * @returns true on success, false on any failure (bad file, no permission).
 */
export function writeConfig(updates = {}, removes = [], explicit) {
  const file = patchFile(explicit)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    raw = '' // file absent — treat as an empty user layer and create it
  }

  // Parse into a comment-preserving document; refuse anything that isn't a
  // valid top-level array rather than risk clobbering real user config.
  let doc
  if (raw.trim().length === 0) {
    doc = new Document([])
  } else {
    try {
      doc = parseDocument(raw)
    } catch {
      return false // present but unparseable — never overwrite destructively
    }
    if (doc.errors.length > 0) return false
    if (!doc.contents || !isSeq(doc.contents)) return false
  }

  // Compute the merged plain-object config for our row.
  const items = doc.contents.items.map((n) => n.toJSON())
  const idx = rowIndex(items)
  const existingCfg = idx !== -1 && items[idx] && typeof items[idx].config === 'object'
    ? items[idx].config
    : {}
  const cfg = { ...existingCfg }

  for (const key of removes) delete cfg[key]
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') delete cfg[key]
    else cfg[key] = value
  }

  const unlock = lockPatchFile(file)
  try {
    if (idx !== -1) {
      if (Object.keys(cfg).length === 0) {
        // Drop our now-empty row entirely (restore clean state).
        doc.contents.items.splice(idx, 1)
      } else {
        // Replace only OUR row's config node; sibling nodes (and their
        // comments) are left untouched by the Document AST.
        doc.contents.items[idx].set('config', doc.createNode(cfg))
      }
    } else if (Object.keys(cfg).length > 0) {
      doc.contents.items.push(doc.createNode({ id: PLUGIN_ID, config: cfg }))
    }

    // Serialize (empty seq renders as `[]`), normalize trailing newline,
    // ensure the profile dir exists, and write atomically.
    let text = doc.toString({ indent: 2 })
    text = `${text.replace(/\n*$/, '')}\n`
    mkdirSync(dirname(file), { recursive: true })
    atomicWrite(file, text)
    return true
  } catch {
    return false
  } finally {
    unlock()
  }
}

// Re-export for callers that need raw stringification consistent with ours.
export { stringify as stringifyYaml }

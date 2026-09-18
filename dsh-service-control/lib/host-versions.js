/**
 * dsh-service-control — hosting launcher detection for `self info`.
 *
 * `self info` reports the host launcher's version — the package whose version
 * `dsh --version` prints. The launcher runs one-shot commands in-process (it
 * does not fork a child), so `process.argv[1]` is its own bin script; walking
 * up from there finds the launcher's package.json. A PATH lookup of `dsh`
 * covers embeddings that do not expose the launcher as argv[1].
 *
 * Nothing here writes or executes: pure reads plus path resolution.
 */
import fs from 'node:fs'
import path from 'node:path'

/** The launcher package; its version is what `dsh --version` reports. */
export const LAUNCHER_PKG = '@deepseek-ai/dsh'

/** Parse a JSON file; null when missing or unparsable. */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Locate an executable on PATH without spawning a shell. */
export function whichSync(name, env = process.env) {
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    try {
      fs.accessSync(file, fs.constants.X_OK)
      return file
    } catch {}
  }
  return null
}

/** Resolve symlinks; fall back to the given path when it does not exist. */
function realOrSelf(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return file
  }
}

/**
 * Walk up from `start` (file or directory) to the package.json of package
 * `name`. Returns `{ dir, pkg, pkgPath }` or null.
 */
export function findUpPackage(start, name) {
  let dir = path.resolve(start)
  try {
    if (fs.statSync(dir).isFile()) dir = path.dirname(dir)
  } catch {}
  while (dir && dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, 'package.json')
    const pkg = readJson(pkgPath)
    if (pkg?.name === name) return { dir, pkg, pkgPath }
    dir = path.dirname(dir)
  }
  return null
}

/**
 * The hosting dsh launcher, or null when it cannot be located (tests, other
 * embeddings). `argv1` defaults to the running process's entry script.
 */
export function detectLauncher({ argv1 = process.argv[1], env = process.env } = {}) {
  const candidates = []
  if (argv1) candidates.push(realOrSelf(String(argv1)))
  // Fallback for embeddings that do not expose the launcher as argv[1].
  const onPath = whichSync('dsh', env)
  if (onPath) candidates.push(realOrSelf(onPath))
  for (const candidate of candidates) {
    const found = findUpPackage(candidate, LAUNCHER_PKG)
    if (found) return { ...found, version: found.pkg.version ?? null }
  }
  return null
}

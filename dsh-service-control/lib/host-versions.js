/**
 * dsh-service-control — host version probing for `self info`.
 *
 * `self info` must report what is actually installed, not what the plugin asks
 * for in its manifest. Three distinct facts matter, and they are easy to
 * conflate:
 *
 *   - the hosting dsh launcher — the package whose version `dsh --version`
 *     prints. The launcher runs one-shot commands in-process (it does not fork
 *     a child), so `process.argv[1]` is its own bin script; walking up from it
 *     finds the launcher's package.json.
 *   - the `@deepseek-ai/dsh-cmdline` copy this plugin actually loads. Node
 *     resolves it from the plugin's own install directory, so the declared
 *     semver range (`^0.1.1-rc.2`) says nothing about the version in use.
 *   - the `@deepseek-ai/dsh-cmdline` copy the harness itself uses. It ships
 *     inside the dsh installation, and because the plugin resolves its own
 *     copy the two can drift apart on a shared channel (cmdlineArgs /
 *     parseCmdline) — worth surfacing rather than hiding behind a range.
 *
 * Nothing here writes or executes: pure reads plus Node's resolver.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** The command-line channel package shared with the harness. */
export const CMDLINE_PKG = '@deepseek-ai/dsh-cmdline'
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

/**
 * Absolute path of `spec`'s package.json as resolved from `from` (a file path
 * or a `file:` URL such as `import.meta.url`), or null. Needs the package to
 * export `./package.json` — `@deepseek-ai/dsh-cmdline` does.
 */
export function resolvePackageJson(spec, from) {
  try {
    return createRequire(from).resolve(`${spec}/package.json`)
  } catch {
    return null
  }
}

/**
 * Version actually resolved for `spec` from `from` — the installed copy, not
 * the declared range. Null when the package cannot be resolved or has no
 * version.
 */
export function resolvePackageVersion(spec, from) {
  const file = resolvePackageJson(spec, from)
  const pkg = file ? readJson(file) : null
  return typeof pkg?.version === 'string' ? pkg.version : null
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

/**
 * The version view behind `self info`:
 *   dsh             — launcher version (what `dsh --version` prints)
 *   dshPath         — launcher install directory
 *   cmdline         — version this plugin actually loads
 *   harnessCmdline  — version the harness ships and uses
 *   declared        — the range this plugin's package.json asks for
 *   drift           — true when the two cmdline copies differ
 */
export function hostVersions({
  argv1 = process.argv[1],
  env = process.env,
  pluginUrl = import.meta.url,
  declared = null,
} = {}) {
  const launcher = detectLauncher({ argv1, env })
  const cmdline = resolvePackageVersion(CMDLINE_PKG, pluginUrl)
  const harnessCmdline = launcher ? resolvePackageVersion(CMDLINE_PKG, launcher.pkgPath) : null
  return {
    dsh: launcher?.version ?? null,
    dshPath: launcher?.dir ?? null,
    cmdline,
    harnessCmdline,
    declared,
    drift: Boolean(cmdline && harnessCmdline && cmdline !== harnessCmdline),
  }
}

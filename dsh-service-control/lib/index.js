/**
 * dsh-service-control — host half.
 *
 * Registers HTTP routes on the dsh webServer:
 *   GET  /dsh-health            liveness probe
 *   GET  /dsh-service/status    service state (running/pid/port/url)
 *   POST /dsh-service/start     background start via scripts/control.sh
 *   POST /dsh-service/stop      graceful stop (SIGINT, SIGTERM fallback)
 *   POST /dsh-service/restart   detached delayed restart (survives this process dying)
 *
 * The control logic lives OUTSIDE the dsh process in scripts/control.sh —
 * shared with the standalone CLI (bin/dshctl.js) so there is one source of
 * truth for process management. Restart spawns a detached process that sleeps
 * briefly so the frontend can render the "restarting" state, then stops and
 * restarts dsh after this process has exited.
 */
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-service-control'
export const inject = ['webServer']

// schemastery fields are optional by default (use .required() to mark
// required), matching the official dsh-host-webserver Config style.
export const Config = z.object({
  profile: z.string(),
})

const here = path.dirname(fileURLToPath(import.meta.url))
const CONTROL = path.join(here, '..', 'scripts', 'control.sh')

/** The profile this host booted (`--profile <name>` on the dsh CLI invocation). */
function argvProfile() {
  const argv = process.argv
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) return argv[flag + 1]
  return undefined
}

/** Run control.sh and resolve { code, stdout, stderr }. */
function runControl(args, { timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(CONTROL, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() })
    })
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function apply(ctx, config) {
  const logger = ctx.logger('dsh-service-control')
  const profile = config?.profile ?? argvProfile() ?? 'web'
  const base = ['--profile', profile]
  let restarting = false
  let stopping = false

  const disposeHealth = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-health',
    handler: async (_req, res) => json(res, 200, { ok: true, ts: Date.now() }),
  })

  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-service/status',
    handler: async (_req, res) => {
      const r = await runControl([...base, 'status'])
      if (r.code !== 0) return json(res, 500, { ok: false, error: r.stderr || r.stdout })
      try {
        json(res, 200, { ok: true, ...JSON.parse(r.stdout) })
      } catch {
        json(res, 500, { ok: false, error: `bad status output: ${r.stdout}` })
      }
    },
  })

  const disposeStart = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-service/start',
    handler: async (_req, res) => {
      const r = await runControl([...base, 'start'], { timeout: 45000 })
      json(res, r.code === 0 ? 200 : 500, parseOr(r))
    },
  })

  const disposeStop = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-service/stop',
    handler: async (req, res) => {
      if (reqMethod(req) !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      if (stopping) return json(res, 200, { ok: false, message: 'stop already in progress' })
      stopping = true
      try {
        // Detached process: this dsh process is about to die, so the stop
        // must run outside it (same pattern as restart).
        // Array args + "$@" keep profile/CONTROL out of any shell parsing.
        const child = spawn('sh', ['-c', 'sleep 1; exec "$@"', 'sh', CONTROL, ...base, 'stop'], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
        json(res, 200, { ok: true, message: 'stopping: dsh is shutting down' })
      } catch (err) {
        stopping = false
        json(res, 500, { ok: false, error: String(err) })
      }
    },
  })

  const disposeRestart = ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-service/restart',
    handler: async (_req, res) => {
      if (reqMethod(_req) !== 'POST') return json(res, 405, { ok: false, message: 'method not allowed' })
      if (restarting) return json(res, 200, { ok: false, message: 'restart already in progress' })
      restarting = true
      try {
        // Detached process: survives this dsh process being killed by stop.
        // Sleep first so the browser can render the restarting state.
        // Array args + "$@" keep profile/CONTROL out of any shell parsing.
        const child = spawn('sh', ['-c', 'sleep 3; exec "$@"', 'sh', CONTROL, ...base, 'restart'], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()
        logger.info('restart scheduled for profile %s', profile)
        json(res, 200, { ok: true, message: 'restart triggered: dsh will come back in a few seconds' })
      } catch (err) {
        restarting = false
        json(res, 500, { ok: false, error: String(err) })
      }
    },
  })

  return () => {
    disposeHealth()
    disposeStatus()
    disposeStart()
    disposeStop()
    disposeRestart()
  }
}

function reqMethod(req) {
  return (req.method || 'GET').toUpperCase()
}

function parseOr(r) {
  try {
    return { ok: r.code === 0, ...JSON.parse(r.stdout) }
  } catch {
    return { ok: r.code === 0, error: r.stderr || r.stdout }
  }
}

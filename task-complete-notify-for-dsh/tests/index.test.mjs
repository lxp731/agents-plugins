import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect config persistence to a temp dir so tests never touch the real
// ~/.dsh user config. persist.js reads process.env.DSH_HOME at call time.
const DSH_HOME = join(tmpdir(), `tcn-home-${process.pid}`)
process.env.DSH_HOME = DSH_HOME
const cleanups = []
cleanups.push(() => rmSync(join(DSH_HOME, 'profiles'), { recursive: true, force: true }))
import { after } from 'node:test'
after(() => { for (const c of cleanups) c() })

// Load the plugin entry. It imports @deepseek-ai/schemastery and
// @deepseek-ai/dsh-tools, which are peers provided by the dsh harness.
const index = await import('../lib/index.js')

/** Build a mock ctx. Services map lists which injectable services are present. */
function makeCtx(services = ['tools', 'commands']) {
  const listeners = {}
  const state = { toolsRegistered: [], commandsRegistered: [] }
  const svc = {
    tools: { register: (def) => state.toolsRegistered.push(def) },
    commands: { register: (def) => state.commandsRegistered.push(def) },
  }
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    on: (name, fn) => {
      listeners[name] = fn
      return () => {}
    },
    inject: (names, cb) => {
      // Simulate cordis: invoke cb only if every requested service name is
      // available, with a sctx exposing those services + effect().
      if (names.every((s) => services.includes(s))) {
        const sctx = {
          ...svc,
          effect: (fn) => {
            typeof fn === 'function' ? fn() : null
            return () => {}
          },
        }
        return cb(sctx)
      }
    },
  }
  return { ctx, state, listeners }
}

test('module exports the plugin contract', () => {
  assert.equal(index.name, 'task-complete-notify-for-dsh')
  assert.equal(typeof index.apply, 'function')
  assert.ok(index.Config, 'Config schema exported')
})

test('apply() wires event listeners and registers tool + command', () => {
  const { ctx, state, listeners } = makeCtx()
  index.apply(ctx, { enabled: true })
  assert.ok(listeners['session/event'], 'session/event listener registered')
  assert.ok(listeners['agent/status'], 'agent/status listener registered')
  assert.equal(state.toolsRegistered.length, 1, 'notify tool registered')
  assert.equal(state.toolsRegistered[0].name, 'notify')
  assert.equal(state.commandsRegistered.length, 1)
  assert.equal(state.commandsRegistered[0].name, 'notify-threshold')
})

test('apply() skips tool/command when services absent (headless)', () => {
  const { ctx, state } = makeCtx([]) // no tools, no commands services
  index.apply(ctx, { enabled: true })
  assert.equal(state.toolsRegistered.length, 0)
  assert.equal(state.commandsRegistered.length, 0)
})

test('notify tool: executes and returns ok', async () => {
  const { ctx, state } = makeCtx()
  index.apply(ctx, { enabled: true, sound: false })
  const tool = state.toolsRegistered[0]
  const ok = await tool.execute({ message: 'build ok' }, {})
  assert.deepEqual(ok, { ok: true })
})

test('notify-threshold command: set and read threshold', () => {
  const { ctx, state } = makeCtx()
  index.apply(ctx, { enabled: true })
  const command = state.commandsRegistered[0]
  const r1 = command.handler({ rawInput: '' })
  assert.equal(r1.kind, 'success')
  assert.match(r1.text, /当前通知阈值/)
  const r2 = command.handler({ rawInput: '30' })
  assert.equal(r2.kind, 'success')
  assert.match(r2.text, /30/)
  const r3 = command.handler({ rawInput: 'abc' })
  assert.equal(r3.kind, 'error')
})

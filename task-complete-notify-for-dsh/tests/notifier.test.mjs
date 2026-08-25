import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TRACKED, resultFor, RunEndNotifier, BlockedNotifier } from '../lib/notifier.js'

function session(id, { origin } = {}) {
  return {
    header: { id, ...(origin ? { origin } : {}) },
    events: [],
  }
}

test('resultFor maps completion kinds to message keys + severity', () => {
  // Keys are resolved to localized text by lib/messages.js at notify time.
  assert.equal(resultFor('completed').severity, 'normal')
  assert.equal(resultFor('completed').key, 'completed')
  assert.equal(resultFor('error').severity, 'critical')
  assert.equal(resultFor('error').key, 'error')
  assert.equal(resultFor('max-tokens').key, 'max-tokens')
  assert.equal(resultFor('unknown').key, 'unknown')
})

test('RunEndNotifier fires once at idle with the final reason', () => {
  const calls = []
  const n = new RunEndNotifier({
    notifyRunEnd: (kind, id, elapsed) => calls.push({ kind, id, elapsed }),
  })
  const s = session('a')
  // a run spanning two turns: first completes, then errors — idle reports error.
  n.onAgentStatus({ status: 'running', agent: { id: 'a', session: s } })
  n.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  n.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'error' } } })
  n.onAgentStatus({ status: 'idle', agent: { id: 'a', session: s } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'error')
})

test('RunEndNotifier ignores subagent sessions', () => {
  const calls = []
  const n = new RunEndNotifier({ notifyRunEnd: (k, id, e) => calls.push({ k, id, e }) })
  const sub = session('sub', { origin: 'subagent' })
  n.onAgentStatus({ status: 'running', agent: { id: 'sub', session: sub } })
  n.onSessionEvent(sub, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  n.onAgentStatus({ status: 'idle', agent: { id: 'sub', session: sub } })
  assert.equal(calls.length, 0)
})

test('RunEndNotifier does not report when no turn ended in the activity', () => {
  const calls = []
  const n = new RunEndNotifier({ notifyRunEnd: (k, id, e) => calls.push({ k, id, e }) })
  const s = session('a')
  n.onAgentStatus({ status: 'running', agent: { id: 'a', session: s } })
  n.onAgentStatus({ status: 'idle', agent: { id: 'a', session: s } })
  assert.equal(calls.length, 0)
})

test('RunEndNotifier measures elapsed time', () => {
  let start = 0
  const calls = []
  const realNow = Date.now
  Date.now = () => (start ? 20000 : (start = 10000))
  try {
    const n = new RunEndNotifier({ notifyRunEnd: (k, id, elapsed) => calls.push(elapsed) })
    const s = session('a')
    n.onAgentStatus({ status: 'running', agent: { id: 'a', session: s } })
    n.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    n.onAgentStatus({ status: 'idle', agent: { id: 'a', session: s } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0], 10)
  } finally {
    Date.now = realNow
  }
})

test('RunEndNotifier evicts oldest entries when tracking maps exceed the cap', () => {
  const calls = []
  const n = new RunEndNotifier({ notifyRunEnd: (k, id) => calls.push(id) })
  const s = session('a')
  // Flood turn/end reasons past the cap; oldest must be evicted.
  n.onAgentStatus({ status: 'running', agent: { id: 'a', session: s } })
  for (let i = 0; i < MAX_TRACKED + 10; i++) {
    n.onSessionEvent(session(`s${i}`), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  }
  assert.ok(n.reasons.size <= MAX_TRACKED)
})

test('RunEndNotifier clears leftover state at idle even without a reason', () => {
  const calls = []
  const n = new RunEndNotifier({ notifyRunEnd: (k, id, e) => calls.push(e) })
  const s = session('a')
  // A crashed previous run left a reason behind; next idle must consume it
  // rather than leak it into the following activity.
  n.onSessionEvent(s, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  n.onAgentStatus({ status: 'idle', agent: { id: 'a', session: s } })
  assert.equal(calls.length, 1)
  n.onAgentStatus({ status: 'idle', agent: { id: 'a', session: s } })
  assert.equal(calls.length, 1, 'stale state must not re-fire')
})

test('BlockedNotifier fires on approval/asked', () => {
  const calls = []
  const b = new BlockedNotifier({ cooldownMs: 0, notifyBlocked: (kind, detail) => calls.push({ kind, detail }) })
  const s = session('a')
  b.onSessionEvent(s, { type: 'approval/asked', data: { toolName: 'bash', reason: 'sandbox escalation' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'approval')
  assert.match(calls[0].detail, /bash/)
})

test('BlockedNotifier fires on ask_user_question', () => {
  const calls = []
  const b = new BlockedNotifier({ cooldownMs: 0, notifyBlocked: (kind, detail) => calls.push({ kind, detail }) })
  const s = session('a')
  b.onSessionEvent(s, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"question":"which env?"}' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'question')
  assert.equal(calls[0].detail, 'which env?')
})

test('BlockedNotifier ignores subagents', () => {
  const calls = []
  const b = new BlockedNotifier({ cooldownMs: 0, notifyBlocked: (kind, detail) => calls.push({ kind, detail }) })
  const sub = session('sub', { origin: 'subagent' })
  b.onSessionEvent(sub, { type: 'approval/asked', data: { toolName: 'bash' } })
  assert.equal(calls.length, 0)
})

test('BlockedNotifier suppresses repeats within the cooldown window per session+kind', () => {
  let now = 1000
  const calls = []
  const b = new BlockedNotifier({
    cooldownMs: 60_000,
    now: () => now,
    notifyBlocked: (kind) => calls.push(kind),
  })
  const s = session('a')
  const ask = { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{}' } }
  b.onSessionEvent(s, ask)
  now += 5_000 // 5s later — retry
  b.onSessionEvent(s, ask)
  assert.equal(calls.length, 1, 'retry within window suppressed')
  now += 60_000 // past the window — fires again
  b.onSessionEvent(s, ask)
  assert.equal(calls.length, 2)
  // A different session is NOT suppressed by session a's cooldown.
  b.onSessionEvent(session('b'), ask)
  assert.equal(calls.length, 3)
})

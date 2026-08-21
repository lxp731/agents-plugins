import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resultFor, RunEndNotifier, BlockedNotifier } from '../lib/notifier.js'

function session(id, { origin } = {}) {
  return {
    header: { id, ...(origin ? { origin } : {}) },
    events: [],
  }
}

test('resultFor maps completion kinds to text + severity', () => {
  assert.equal(resultFor('completed').severity, 'normal')
  assert.equal(resultFor('completed').text, '✅ 任务完成')
  assert.equal(resultFor('error').severity, 'critical')
  assert.equal(resultFor('error').text, '❌ 任务失败')
  assert.equal(resultFor('max-tokens').text, '⚠️ 任务达到 token 上限')
  assert.equal(resultFor('unknown').severity, 'normal')
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

test('BlockedNotifier fires on approval/asked', () => {
  const calls = []
  const b = new BlockedNotifier({ notifyBlocked: (kind, detail) => calls.push({ kind, detail }) })
  const s = session('a')
  b.onSessionEvent(s, { type: 'approval/asked', data: { toolName: 'bash', reason: 'sandbox escalation' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'approval')
  assert.match(calls[0].detail, /bash/)
})

test('BlockedNotifier fires on ask_user_question', () => {
  const calls = []
  const b = new BlockedNotifier({ notifyBlocked: (kind, detail) => calls.push({ kind, detail }) })
  const s = session('a')
  b.onSessionEvent(s, { type: 'tool/call', data: { name: 'ask_user_question', arguments: '{"question":"which env?"}' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].kind, 'question')
  assert.equal(calls[0].detail, 'which env?')
})

test('BlockedNotifier ignores subagents', () => {
  const calls = []
  const b = new BlockedNotifier({ notifyBlocked: (kind, detail) => calls.push({ kind, detail }) })
  const sub = session('sub', { origin: 'subagent' })
  b.onSessionEvent(sub, { type: 'approval/asked', data: { toolName: 'bash' } })
  assert.equal(calls.length, 0)
})

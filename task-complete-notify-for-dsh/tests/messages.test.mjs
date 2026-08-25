import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messagesFor, normalizeLang } from '../lib/messages.js'

test('normalizeLang falls back to zh on unknown values', () => {
  assert.equal(normalizeLang('en'), 'en')
  assert.equal(normalizeLang('zh'), 'zh')
  assert.equal(normalizeLang('fr'), 'zh')
  assert.equal(normalizeLang(undefined), 'zh')
})

test('zh table maps every run-end reason kind', () => {
  const m = messagesFor('zh')
  for (const key of ['completed', 'error', 'aborted', 'max-tokens', 'blocked', 'interrupted', 'unknown']) {
    assert.ok(typeof m.runEnd[key] === 'string' && m.runEnd[key].length > 0, `runEnd.${key}`)
  }
})

test('en table mirrors zh keys', () => {
  const zh = messagesFor('zh')
  const en = messagesFor('en')
  assert.deepEqual(Object.keys(en.runEnd), Object.keys(zh.runEnd))
  assert.match(en.question('detail'), /model needs your answer.*detail/s)
})

test('unknown language resolves to the zh table', () => {
  assert.equal(messagesFor('fr'), messagesFor('zh'))
})

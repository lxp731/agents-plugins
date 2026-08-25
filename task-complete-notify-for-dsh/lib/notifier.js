/**
 * task-complete-notify-for-dsh — run-end & blocking-event state machine.
 *
 * A single "run" in DeepSeek Harness can span many turns (goal rounds,
 * follow-ups, steering), each closing with its own `turn/end`. We record the
 * latest `turn/end` reason per root session and fire exactly ONE notification
 * when the root agent returns to `agent/status` `'idle'` — the harness's own
 * "run ended" signal (the web running indicator and whenIdle() derive from it).
 *
 * Blocking user-interactions (a question via `ask_user_question`, or an
 * `approval/asked`) fire an immediate notification, with a per-session cooldown
 * so retries cannot spam the user. Subagent sessions are excluded on all paths
 * via the harness idiom `header.origin === 'subagent'`.
 */

/** Upper bound for tracking maps — prevents unbounded growth if a session
 *  crashes and never returns to idle (entries are evicted oldest-first). */
export const MAX_TRACKED = 256

/**
 * Map a `turn/end` reason.kind to { key, severity }. The key is resolved to
 * localized text via lib/messages.js at notify time, keeping this module
 * language-independent.
 */
export function resultFor(kind) {
  switch (kind) {
    case 'completed': return { key: 'completed', severity: 'normal' }
    case 'error': return { key: 'error', severity: 'critical' }
    case 'aborted': return { key: 'aborted', severity: 'normal' }
    case 'max-tokens': return { key: 'max-tokens', severity: 'normal' }
    case 'blocked': return { key: 'blocked', severity: 'critical' }
    case 'interrupted': return { key: 'interrupted', severity: 'normal' }
    default: return { key: 'unknown', severity: 'normal' }
  }
}

/** Evict the oldest entries of a Map until it is within the cap. */
function prune(map, cap = MAX_TRACKED) {
  while (map.size > cap) {
    const oldest = map.keys().next().value
    map.delete(oldest)
  }
}

/**
 * Tracks root-session turn endings and reports the run's final result exactly
 * once, when the agent returns to idle. Also times the run so a duration
 * threshold can suppress notifications for short tasks.
 */
export class RunEndNotifier {
  constructor(deps) {
    /** Latest turn/end reason kind per root session id, consumed at idle. */
    this.reasons = new Map()
    /** Run start timestamp per root session id (set on running, kept at idle). */
    this.starts = new Map()
    this.deps = deps
  }

  /** Feed `session/event`; records the latest reason kind of a root turn ending. */
  onSessionEvent(session, event) {
    if (event.type !== 'turn/end') return
    if (session.header.origin === 'subagent') return
    const data = event.data || {}
    const kind = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown'
    this.reasons.set(session.header.id, kind)
    prune(this.reasons)
  }

  /** Feed `agent/status`; start the clock on 'running', report once on 'idle'. */
  onAgentStatus(payload) {
    const agent = payload.agent
    const sessionId = agent?.id ?? agent?.session?.header?.id
    if (typeof sessionId !== 'string') return
    if (agent?.session?.header?.origin === 'subagent') return

    if (payload.status === 'running') {
      this.starts.set(sessionId, Date.now())
      prune(this.starts)
    } else if (payload.status === 'idle') {
      // Consume any leftover state for this session, even if we don't notify,
      // so a crashed previous run can never leak into the next one.
      const kind = this.reasons.get(sessionId)
      const start = this.starts.get(sessionId)
      this.reasons.delete(sessionId)
      this.starts.delete(sessionId)
      if (kind === undefined) return // no turn ended in this activity
      const elapsedSec = start ? (Date.now() - start) / 1000 : 0
      this.deps.notifyRunEnd(kind, sessionId, elapsedSec)
    }
  }
}

/**
 * Fires one notification per blocking user-interaction as it happens: a
 * question (`tool/call` naming `ask_user_question`) or an approval ask
 * (`approval/asked`). A per-session cooldown suppresses rapid repeats (tool
 * retries, re-asks) so the user isn't spammed while away. Subagent sessions
 * excluded.
 */
export class BlockedNotifier {
  /**
   * @param deps - { notifyBlocked(kind, detail), now?, cooldownMs? }
   *   now defaults to Date.now; cooldownMs (default 60_000) is the minimum
   *   interval between notifications for the same session+kind.
   */
  constructor(deps) {
    this.deps = deps
    this.now = typeof deps.now === 'function' ? deps.now : Date.now
    this.cooldownMs = typeof deps.cooldownMs === 'number' && deps.cooldownMs >= 0 ? deps.cooldownMs : 60_000
    /** Last fired timestamp per `${sessionId}:${kind}`. */
    this.lastFired = new Map()
  }

  /** Feed `session/event`; report blocking interactions on root sessions only. */
  onSessionEvent(session, event) {
    if (session.header.origin === 'subagent') return
    if (event.type === 'tool/call') {
      const data = event.data || {}
      if (data.name !== 'ask_user_question') return
      const detail = typeof data.arguments === 'string' ? extractQuestionText(data.arguments) : ''
      this.fire(session.header.id, 'question', detail)
    } else if (event.type === 'approval/asked') {
      const data = event.data || {}
      const toolName = typeof data.toolName === 'string' ? data.toolName : ''
      const reason = typeof data.reason === 'string' && data.reason ? `：${data.reason}` : ''
      this.fire(session.header.id, 'approval', `${toolName}${reason}`)
    }
  }

  /** Fire through to deps unless the same session+kind fired within the window. */
  fire(sessionId, kind, detail) {
    const key = `${sessionId}:${kind}`
    const last = this.lastFired.get(key) ?? -Infinity
    const now = this.now()
    if (now - last < this.cooldownMs) return
    this.lastFired.set(key, now)
    prune(this.lastFired)
    this.deps.notifyBlocked(kind, detail)
  }
}

/** Pull a short text fragment out of a serialized ask_user_question arguments JSON. */
function extractQuestionText(raw) {
  try {
    const parsed = JSON.parse(raw)
    for (const key of ['question', 'message', 'text', 'content']) {
      if (typeof parsed[key] === 'string' && parsed[key]) return truncate(parsed[key], 80)
    }
    const str = JSON.stringify(parsed)
    return str ? truncate(str, 80) : ''
  } catch {
    return truncate(raw, 80)
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

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
 * `approval/asked`) fire an immediate notification, because each is a separate
 * "the session is waiting on you" moment.
 *
 * Subagent sessions are excluded on all paths via the harness idiom
 * `header.origin === 'subagent'`.
 */

/** Map `turn/end` reason.kind → { text, severity } for the notification. */
export function resultFor(kind) {
  switch (kind) {
    case 'completed': return { text: '✅ 任务完成', severity: 'normal' }
    case 'error': return { text: '❌ 任务失败', severity: 'critical' }
    case 'aborted': return { text: '⏹ 任务已中止', severity: 'normal' }
    case 'max-tokens': return { text: '⚠️ 任务达到 token 上限', severity: 'normal' }
    case 'blocked': return { text: '⏸ 任务已阻塞', severity: 'critical' }
    case 'interrupted': return { text: '⏹ 任务已中断', severity: 'normal' }
    default: return { text: '🔔 任务结束', severity: 'normal' }
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
  }

  /** Feed `agent/status`; start the clock on 'running', report once on 'idle'. */
  onAgentStatus(payload) {
    const agent = payload.agent
    const sessionId = agent?.id ?? agent?.session?.header?.id
    if (typeof sessionId !== 'string') return
    if (agent?.session?.header?.origin === 'subagent') return

    if (payload.status === 'running') {
      this.starts.set(sessionId, Date.now())
    } else if (payload.status === 'idle') {
      const kind = this.reasons.get(sessionId)
      const start = this.starts.get(sessionId)
      this.starts.delete(sessionId)
      if (kind === undefined) return // no turn ended in this activity
      this.reasons.delete(sessionId)
      const elapsedSec = start ? (Date.now() - start) / 1000 : 0
      this.deps.notifyRunEnd(kind, sessionId, elapsedSec)
    }
  }
}

/**
 * Fires one notification per blocking user-interaction as it happens: a
 * question (`tool/call` naming `ask_user_question`) or an approval ask
 * (`approval/asked`). Subagent sessions excluded.
 */
export class BlockedNotifier {
  constructor(deps) {
    this.deps = deps
  }

  /** Feed `session/event`; report blocking interactions on root sessions only. */
  onSessionEvent(session, event) {
    if (session.header.origin === 'subagent') return
    if (event.type === 'tool/call') {
      const data = event.data || {}
      if (data.name !== 'ask_user_question') return
      const detail = typeof data.arguments === 'string' ? extractQuestionText(data.arguments) : ''
      this.deps.notifyBlocked('question', detail)
    } else if (event.type === 'approval/asked') {
      const data = event.data || {}
      const toolName = typeof data.toolName === 'string' ? data.toolName : '工具'
      const reason = typeof data.reason === 'string' && data.reason ? `：${data.reason}` : ''
      this.deps.notifyBlocked('approval', `${toolName}${reason}`)
    }
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

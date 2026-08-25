/**
 * task-complete-notify-for-dsh — desktop notification + chime for DeepSeek Harness.
 *
 * Notifies the OS when a root-session run ends (completion, error, abort,
 * token limit), and immediately on blocking user-interactions (a model question
 * or an approval request). A configurable duration threshold suppresses
 * notifications for short runs, so you're only alerted when you'd actually
 * switch away and wait.
 *
 * Reliability features:
 *  - All notification/persistence failures are logged (never silent).
 *  - Blocking-event notifications are rate-limited per session (cooldown).
 *  - A startup self-check warns if the harness event API appears changed.
 *  - Profile resolution warns when it has to fall back to 'web'.
 *  - Config persistence preserves user comments and writes atomically.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { notify } from './notify.js'
import { resultFor, RunEndNotifier, BlockedNotifier } from './notifier.js'
import { messagesFor, normalizeLang } from './messages.js'
import { writeConfig, resolveProfileDetailed } from './persist.js'

export const name = 'task-complete-notify-for-dsh'

// schemastery fields are optional by default; use .required() where a value
// must always be present. Defaults fill the rest.
export const Config = z.object({
  enabled: z.boolean().default(true),
  // Minimum run duration (seconds) before a completion notifies; 0 = always.
  threshold: z.number().default(0),
  title: z.string().default('DeepSeek Harness'),
  sound: z.boolean().default(true),
  // Notify when the model asks a question (ask_user_question).
  onQuestion: z.boolean().default(true),
  // Notify when the harness waits for approval.
  onApproval: z.boolean().default(true),
  // Absolute path to a custom chime audio file; overrides the bundled
  // prompt-tone.mp3. Leave empty to use the default.
  chimeFile: z.string().default(''),
  // Message language for notifications and command replies.
  lang: z.string().default('zh'),
  // Minimum seconds between blocking notifications for the same session+kind
  // (question / approval retries would otherwise spam while you're away).
  blockedCooldownSec: z.number().default(60),
  // Minimum seconds between model-invoked `notify` tool calls (anti-spam).
  toolCooldownSec: z.number().default(10),
})

// Legacy aliases accepted defensively for direct callers of the tool.
const STATUS_ALIAS = { 完成: 'success', 失败: 'failure' }

export function apply(ctx, config = {}) {
  const logger = ctx.logger(name)
  const platform = process.platform
  // Resolve the active profile; WARN when we had to fall back to 'web', since
  // runtime persistence (/notify-threshold) would silently target that profile.
  const resolved = resolveProfileDetailed()
  if (resolved.source === 'fallback') {
    logger.warn(
      'could not determine active profile (no DSH_PROFILE env, no --profile argv) — falling back to "web"; runtime config changes will persist to profile "web"',
    )
  }
  const profile = resolved.profile

  // Merge entry config (from cordis.patch.yml / settings) with defaults. The
  // user layer may also carry a row written at runtime (e.g. /notify-threshold);
  // dsh already folds it into `config`, so the entry value is authoritative.
  const c = {
    enabled: config.enabled ?? true,
    threshold: typeof config.threshold === 'number' && config.threshold >= 0 ? config.threshold : 0,
    title: typeof config.title === 'string' && config.title ? config.title : 'DeepSeek Harness',
    sound: config.sound ?? true,
    onQuestion: config.onQuestion ?? true,
    onApproval: config.onApproval ?? true,
    chimeFile: typeof config.chimeFile === 'string' ? config.chimeFile : '',
    lang: normalizeLang(typeof config.lang === 'string' ? config.lang : undefined),
    blockedCooldownSec: typeof config.blockedCooldownSec === 'number' && config.blockedCooldownSec >= 0 ? config.blockedCooldownSec : 60,
    toolCooldownSec: typeof config.toolCooldownSec === 'number' && config.toolCooldownSec >= 0 ? config.toolCooldownSec : 10,
  }
  const msgs = () => messagesFor(c.lang)

  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') {
    logger.warn('unsupported platform "%s" — notifications disabled', platform)
    return
  }

  /** Active gate: master switch + quiet-free. */
  const active = () => c.enabled

  const notifier = new RunEndNotifier({
    notifyRunEnd: (kind, sessionId, elapsedSec) => {
      if (!active()) return
      if (c.threshold > 0 && elapsedSec < c.threshold) return // short run: skip
      const r = resultFor(kind)
      const m = msgs()
      const text = m.runEnd[r.key] ?? m.runEnd.unknown
      notify({
        title: c.title,
        message: `${text} — ${formatElapsed(elapsedSec)} ${m.sessionSuffix(sessionId)}`,
        severity: r.severity,
        sound: c.sound,
        chimeFile: c.chimeFile,
        logger,
      })
    },
  })

  const blockedNotifier = new BlockedNotifier({
    cooldownMs: c.blockedCooldownSec * 1000,
    notifyBlocked: (kind, detail) => {
      if (!active()) return
      if (kind === 'question' && !c.onQuestion) return
      if (kind === 'approval' && !c.onApproval) return
      const m = msgs()
      const message = kind === 'question' ? m.question(detail) : m.approval(detail)
      notify({ title: c.title, message, severity: 'critical', sound: c.sound, chimeFile: c.chimeFile, logger })
    },
  })

  // --- host-API self-check ---------------------------------------------------
  // The typed session/event & agent/status declarations live in unpublished
  // @deepseek-ai packages; if their names/shapes ever change, this plugin would
  // silently stop working. Warn once if NOTHING arrived within 5 minutes of a
  // session where events were expected.
  const seen = { sessionEvent: false, agentStatus: false }
  setTimeout(() => {
    if (!seen.sessionEvent && !seen.agentStatus && active()) {
      logger.warn(
        'no session/event or agent/status received within 5 minutes — if dsh was updated recently, its event API may have changed and this plugin can no longer observe runs',
      )
    }
  }, 5 * 60_000).unref()

  // The harness's typed `session/event` / `agent/status` declarations live in
  // the unpublished @deepseek-ai/dsh-session / dsh-agent packages, so register
  // with a narrowed cast; payload shapes are pinned structurally in notifier.js.
  const register = ctx.on
  register('session/event', (session, event) => {
    seen.sessionEvent = true
    notifier.onSessionEvent(session, event)
    blockedNotifier.onSessionEvent(session, event)
  })
  register('agent/status', (payload) => {
    seen.agentStatus = true
    notifier.onAgentStatus(payload)
  })

  // Optional: a model-callable notify tool. The tools service is injected only
  // in contexts that provide it (web + agent); the inject callback is skipped
  // entirely elsewhere (e.g. headless CLI one-shots), so no registration happens.
  ctx.inject(['tools'], (sctx) => {
    try {
      sctx.effect(() => sctx.tools.register(toolNotify(c, msgs, logger)), 'task-complete-notify: notify tool')
    } catch (err) {
      logger.warn('notify tool registration failed: %s', err)
    }
  })

  // Optional: /notify-threshold command. Same inject pattern as the tool above.
  // Persists to the user layer (cordis.patch.yml) so the change survives a
  // restart — the standard dsh way to make runtime config durable.
  ctx.inject(['commands'], (sctx) => {
    sctx.effect(() => sctx.commands.register({
      name: 'notify-threshold',
      description: 'set notification duration threshold (seconds); 0 = always notify',
      input: { hint: '[<seconds>]' },
      handler: (invocation) => {
        const m = msgs()
        const input = String(invocation.rawInput ?? '').trim()
        if (!input) return { kind: 'success', text: m.cmdCurrent(c.threshold) }
        const v = parseFloat(input)
        if (isNaN(v) || v < 0) return { kind: 'error', text: m.cmdInvalid(input) }
        c.threshold = v
        const saved = writeConfig({ threshold: v }, [], profile)
        if (!saved) logger.warn('failed to persist threshold=%s to %s', v, profile)
        return { kind: 'success', text: m.cmdSet(v, saved) }
      },
    }), 'task-complete-notify: notify-threshold command')
  })

  // Warn once at startup if a custom chime is configured but missing.
  if (c.chimeFile && !existsSync(c.chimeFile)) {
    logger.warn('configured chimeFile not found: %s (falling back to default)', c.chimeFile)
  }
}

function toolNotify(c, msgs, logger) {
  // Anti-spam: the model could otherwise fire notify() in a tight loop.
  let lastFiredAt = -Infinity
  return defineTool({
    name: 'notify',
    description:
      'Send a desktop notification and chime to alert the user. Use it for long-running task completion, task failure, or when the user should return to the screen for an important result.',
    parameters: {
      message: { type: 'string', required: true, description: 'Notification content' },
      status: {
        type: 'string',
        enum: ['success', 'failure'],
        description: '"success" (default) or "failure"; affects title and urgency',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean', required: true }, throttled: { type: 'boolean' } },
      },
      render: () => [{ type: 'text', text: msgs().toolDone }],
    },
    async execute(args) {
      const rawStatus = args?.status
      const status = STATUS_ALIAS[rawStatus] ?? rawStatus ?? 'success'
      const isError = status === 'failure'
      const now = Date.now()
      if (now - lastFiredAt < c.toolCooldownSec * 1000) {
        return { ok: false, throttled: true }
      }
      lastFiredAt = now
      notify({
        title: c.title,
        message: isError ? `❌ ${args.message}` : `✅ ${args.message}`,
        severity: isError ? 'critical' : 'normal',
        sound: c.sound,
        chimeFile: c.chimeFile,
        logger,
      })
      return { ok: true, throttled: false }
    },
  })
}

/** Format elapsed seconds for display: 12s / 1m30s / 2m. */
function formatElapsed(sec) {
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m}m${r}s` : `${m}m`
}

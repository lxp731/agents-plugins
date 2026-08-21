/**
 * task-complete-notify-for-dsh — desktop notification + chime for DeepSeek Harness.
 *
 * Notifies the OS when a root-session run ends (completion, error, abort,
 * token limit), and immediately on blocking user-interactions (a model question
 * or an approval request). A configurable duration threshold suppresses
 * notifications for short runs, so you're only alerted when you'd actually
 * switch away and wait.
 *
 * Improvements over the Pi extension this is ported from:
 *  - Errors now notify: `turn/end` reason=error fires a critical "任务失败".
 *  - Approval requests now notify immediately (approval/asked).
 *  - Model questions now notify immediately (ask_user_question).
 *  - Cross-platform: macOS osascript / Windows PowerShell, plus Linux.
 *
 * Safety: zero runtime dependencies beyond the schemastery schema; notifications
 * are fire-and-forget (detached, unref'd) so a notifier failure never breaks the
 * run being reported. Config lives in cordis.patch.yml (or the settings panel).
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { notify } from './notify.js'
import { resultFor, RunEndNotifier, BlockedNotifier } from './notifier.js'
import { writeConfig, resolveProfile } from './persist.js'

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
})

export function apply(ctx, config = {}) {
  const logger = ctx.logger(name)
  const platform = process.platform
  // Resolve the active profile so /notify-threshold persists to the right user
  // layer even if argv doesn't carry --profile (robustness hardening).
  const profile = resolveProfile()

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
  }

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
      notify(c.title, `${r.text} — ${formatElapsed(elapsedSec)} (session: ${sessionId})`, r.severity, c.sound, c.chimeFile)
    },
  })

  const blockedNotifier = new BlockedNotifier({
    notifyBlocked: (kind, detail) => {
      if (!active()) return
      if (kind === 'question' && !c.onQuestion) return
      if (kind === 'approval' && !c.onApproval) return
      if (kind === 'question') {
        notify(c.title, `💬 模型需要你回答${detail ? `：${detail}` : ''}`, 'critical', c.sound, c.chimeFile)
      } else {
        notify(c.title, `🛡️ 等待审批${detail ? `：${detail}` : ''}`, 'critical', c.sound, c.chimeFile)
      }
    },
  })

  // The harness's typed `session/event` / `agent/status` declarations live in
  // the unpublished @deepseek-ai/dsh-session / dsh-agent packages, so register
  // with a narrowed cast; payload shapes are pinned structurally in notifier.js.
  const register = ctx.on
  register('session/event', (session, event) => {
    notifier.onSessionEvent(session, event)
    blockedNotifier.onSessionEvent(session, event)
  })
  register('agent/status', (payload) => {
    notifier.onAgentStatus(payload)
  })

  // Optional: a model-callable notify tool. The tools service is injected only
  // in contexts that provide it (web + agent); the inject callback is skipped
  // entirely elsewhere (e.g. headless CLI one-shots), so no registration happens.
  ctx.inject(['tools'], (sctx) => {
    try {
      sctx.effect(() => sctx.tools.register(toolNotify(c)), 'task-complete-notify: notify tool')
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
        const input = invocation.rawInput.trim()
        if (!input) {
          return { kind: 'success', text: `当前通知阈值：${c.threshold}s（用法：/notify-threshold <秒>）` }
        }
        const v = parseFloat(input)
        if (isNaN(v) || v < 0) {
          return { kind: 'error', text: `无效值：${input}（请输入非负秒数，0 = 每次都通知）` }
        }
        c.threshold = v
        const saved = writeConfig({ threshold: v }, [], profile)
        return {
          kind: 'success',
          text: `通知阈值已设为 ${v}s${saved ? '（已持久化到用户配置）' : '（本次会话生效，持久化失败）'}`,
        }
      },
    }), 'task-complete-notify: notify-threshold command')
  })

  // Warn once at startup if a custom chime is configured but missing.
  if (c.chimeFile && !existsSync(c.chimeFile)) {
    logger.warn('configured chimeFile not found: %s (falling back to default)', c.chimeFile)
  }
}

function toolNotify(c) {
  return defineTool({
    name: 'notify',
    description:
      'Send a desktop notification and chime to alert the user. Use it for long-running task completion, task failure, or when the user should return to the screen for an important result.',
    parameters: {
      message: { type: 'string', required: true, description: 'Notification content' },
      status: {
        type: 'string',
        enum: ['完成', '失败'],
        description: '完成 (success, default) or 失败 (failure); affects title and urgency',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'notification sent' }],
    },
    async execute(args) {
      const isError = args.status === '失败'
      notify(c.title, isError ? `❌ ${args.message}` : `✅ ${args.message}`, isError ? 'critical' : 'normal', c.sound, c.chimeFile)
      return { ok: true }
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

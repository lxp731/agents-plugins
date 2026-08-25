/**
 * task-complete-notify-for-dsh — user-facing message tables (i18n).
 *
 * All notification/command strings live here so nothing is hardcoded inline.
 * `lang` config selects the table ('zh' default, 'en' available); unknown
 * values fall back to 'zh'. Functions receive already-truncated details.
 */

export const LANGS = ['zh', 'en']

export function normalizeLang(lang) {
  return LANGS.includes(lang) ? lang : 'zh'
}

const TABLES = {
  zh: {
    runEnd: {
      completed: '✅ 任务完成',
      error: '❌ 任务失败',
      aborted: '⏹ 任务已中止',
      'max-tokens': '⚠️ 任务达到 token 上限',
      blocked: '⏸ 任务已阻塞',
      interrupted: '⏹ 任务已中断',
      unknown: '🔔 任务结束',
    },
    question: (detail) => `💬 模型需要你回答${detail ? `：${detail}` : ''}`,
    approval: (detail) => `🛡️ 等待审批${detail ? `：${detail}` : ''}`,
    sessionSuffix: (sessionId) => `(session: ${sessionId})`,
    toolDone: 'notification sent',
    cmdCurrent: (sec) => `当前通知阈值：${sec}s（用法：/notify-threshold <秒>）`,
    cmdInvalid: (input) => `无效值：${input}（请输入非负秒数，0 = 每次都通知）`,
    cmdSet: (v, saved) => `通知阈值已设为 ${v}s${saved ? '（已持久化到用户配置）' : '（本次会话生效，持久化失败）'}`,
  },
  en: {
    runEnd: {
      completed: '✅ Task completed',
      error: '❌ Task failed',
      aborted: '⏹ Task aborted',
      'max-tokens': '⚠️ Token limit reached',
      blocked: '⏸ Task blocked',
      interrupted: '⏹ Task interrupted',
      unknown: '🔔 Run ended',
    },
    question: (detail) => `💬 The model needs your answer${detail ? `: ${detail}` : ''}`,
    approval: (detail) => `🛡️ Awaiting approval${detail ? `: ${detail}` : ''}`,
    sessionSuffix: (sessionId) => `(session: ${sessionId})`,
    toolDone: 'notification sent',
    cmdCurrent: (sec) => `Current notify threshold: ${sec}s (usage: /notify-threshold <seconds>)`,
    cmdInvalid: (input) => `Invalid value: ${input} (enter a non-negative number of seconds; 0 = always notify)`,
    cmdSet: (v, saved) => `Notify threshold set to ${v}s${saved ? ' (persisted to user config)' : ' (session only; persistence failed)'}`,
  },
}

/**
 * Get the message table for a language, falling back to Chinese.
 * @param {string} lang - configured language ('zh' | 'en').
 */
export function messagesFor(lang) {
  return TABLES[normalizeLang(lang)] || TABLES.zh
}

// @ts-nocheck -- SDK type definitions lag behind runtime behavior
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHIME = path.join(__dirname, "..", "assets", "prompt-tone.mp3");

// Player priority: mpv → ffplay → pw-play → cvlc → paplay
const PLAYERS = [
  { cmd: "mpv", args: ["--no-video", "--no-terminal", "--volume=100"] },
  { cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", "100"] },
  { cmd: "pw-play", args: ["--volume=1.0"] },
  { cmd: "cvlc", args: ["--play-and-exit", "--no-osd", "--volume", "256"] },
  { cmd: "paplay", args: [] },
];

let cachedPlayer: { cmd: string; args: string[] } | null = null;
function detectPlayer(): { cmd: string; args: string[] } | null {
  if (cachedPlayer) return cachedPlayer;
  for (const player of PLAYERS) {
    const result = spawnSync("which", [player.cmd], { stdio: "ignore" });
    if (result.status === 0) {
      cachedPlayer = player;
      return player;
    }
  }
  return null;
}

function playChime(env: NodeJS.ProcessEnv) {
  const player = detectPlayer();
  if (!player) return;
  const child = spawn(player.cmd, [...player.args, CHIME], {
    env,
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function notify(message: string, status: "完成" | "失败" = "完成") {
  const title = status === "失败" ? "❌ 任务失败" : "✅ 任务完成";
  const urgency = status === "失败" ? "critical" : "normal";

  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
  };

  execFile("notify-send", ["-u", urgency, title, message, "-t", "5000"], { env }, () => {});

  playChime(env);
}

interface PluginConfig {
  thresholdSeconds?: number;
  noNotify?: boolean;
}

// Track agent run start times by runId for duration calculation
const runStartTimes = new Map<string, number>();

export default definePluginEntry({
  id: "task-complete-notify",
  name: "Task Complete Notify",
  description: "Desktop notification + chime when agent finishes a turn",

  register(api) {
    // --- Hook: record start time when agent run begins ---
    api.on("before_agent_run", async (event) => {
      const runId = (event as Record<string, unknown>).runId as string | undefined;
      if (runId) {
        runStartTimes.set(runId, Date.now());
      }
    });

    // --- Hook: notify when agent turn ends ---
    api.on("agent_end", async (event) => {
      const evt = event as Record<string, unknown>;
      const ctx = evt.context as Record<string, unknown> | undefined;
      const config = (ctx?.pluginConfig ?? {}) as PluginConfig;

      if (config.noNotify) return;

      const thresholdSeconds = config.thresholdSeconds ?? 0;
      const runId = evt.runId as string | undefined;

      let elapsedSec = 0;
      if (runId && runStartTimes.has(runId)) {
        elapsedSec = (Date.now() - runStartTimes.get(runId)!) / 1000;
        runStartTimes.delete(runId);
      }

      if (elapsedSec < thresholdSeconds) return;

      const timeStr = elapsedSec > 0 ? `（耗时 ${elapsedSec.toFixed(1)}s）` : "";
      notify(`OpenClaw 已完成回复${timeStr}`);
    });

    // --- Tool: model-callable notify for explicit invocation ---
    api.registerTool({
      name: "notify",
      description:
        "发送桌面通知和提示音提醒用户。用于长任务完成或失败时提醒用户，或在需要用户离开屏幕等待结果时使用。",
      parameters: Type.Object({
        message: Type.String({ description: "通知内容" }),
        status: Type.Optional(
          Type.Union([Type.Literal("完成"), Type.Literal("失败")]),
        ),
      }),
      async execute(_toolCallId, params) {
        notify(params.message, params.status ?? "完成");
        return {
          content: [{ type: "text", text: "通知已发送" }],
          details: {},
        };
      },
    });
  },
});

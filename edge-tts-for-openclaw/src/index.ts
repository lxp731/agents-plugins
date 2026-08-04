// @ts-nocheck
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Text cleaning for TTS ──────────────────────────────────────────────

function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码部分已省略）")
    .replace(/\|.*\|/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*[-*+]\s/gm, "")
    .trim();
}

// ── TTS engine ─────────────────────────────────────────────────────────

async function speak(text: string, voice: string): Promise<void> {
  if (!text) return;

  const tmpFile = path.join(tmpdir(), `oc-tts-${Date.now()}.mp3`);

  return new Promise((resolve, reject) => {
    execFile(
      "edge-tts",
      ["--text", text, "--voice", voice, "--write-media", tmpFile],
      { timeout: 30000 },
      (err) => {
        if (err) {
          reject(err);
          return;
        }
        // Background playback + cleanup
        const child = execFile(
          "mpv",
          ["--no-video", "--no-terminal", tmpFile],
          (playErr) => {
            try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
          },
        );
        child.unref();
        resolve();
      },
    );
  });
}

// ── Plugin config ──────────────────────────────────────────────────────

interface PluginConfig {
  voice?: string;
  autoSpeak?: "always" | "auto";
}

function readConfigFromFile(): PluginConfig {
  try {
    const home = process.env.HOME || "/tmp";
    const raw = readFileSync(`${home}/.openclaw/openclaw.json`, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.plugins?.entries?.["edge-tts-for-oc"]?.config ?? {};
  } catch {
    return {};
  }
}

// Try hook-event config first, fall back to file read
function getConfig(hookEvent: Record<string, unknown>): PluginConfig {
  const ctx = hookEvent.context as Record<string, unknown> | undefined;
  const hookConfig = ctx?.pluginConfig as PluginConfig | undefined;
  if (hookConfig && (hookConfig.autoSpeak !== undefined || hookConfig.voice)) {
    return hookConfig;
  }
  return readConfigFromFile();
}

// ── Plugin entry ───────────────────────────────────────────────────────

export default definePluginEntry({
  id: "edge-tts-for-oc",
  name: "Edge TTS for OpenClaw",
  description: "Voice replies using Microsoft Edge TTS via edge-tts CLI",

  register(api) {
    // Hook: auto-speak when autoSpeak="always"
    api.on("message_sending", async (event) => {
      const evt = event as Record<string, unknown>;
      const config = getConfig(evt);

      if (config.autoSpeak !== "always") return;

      const rawContent = evt.content as string | undefined;
      if (!rawContent) return;

      const cleaned = cleanForSpeech(rawContent);
      if (!cleaned) return;

      speak(cleaned, config.voice ?? "zh-CN-YunxiaNeural").catch(() => {});
    });

    // Tool: model triggers voice reply with text content
    api.registerTool({
      name: "speak",
      description:
        "用语音朗读文本内容。在回复末尾调用此工具，将你的完整回复内容作为 text 参数传入。当用户要求语音输出、播报、朗读时使用。",
      parameters: Type.Object({
        text: Type.String({ description: "要朗读的文本内容，传入你的完整回复" }),
      }),
      async execute(_toolCallId: string, params: { text: string }) {
        if (!params?.text) {
          return {
            content: [{ type: "text", text: "⚠️ 没有可播放的内容" }],
            details: {},
          };
        }

        const cleaned = cleanForSpeech(params.text);
        if (!cleaned) {
          return {
            content: [{ type: "text", text: "⚠️ 内容清洗后为空" }],
            details: {},
          };
        }

        speak(cleaned, readConfigFromFile().voice ?? "zh-CN-YunxiaNeural").catch(() => {});

        return {
          content: [{ type: "text", text: "🗣️ 语音播放中..." }],
          details: {},
        };
      },
    });
  },
});

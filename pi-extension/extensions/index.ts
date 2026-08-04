import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 提示音资源文件（与 extension 一起分发）
const CHIME = path.join(__dirname, "assets", "prompt-tone.mp3");
// 持久化配置文件（保存 /notify-threshold 设置）
const CONFIG = path.join(__dirname, "config.json");

// 播放器优先级列表：mpv → ffplay → pw-play → cvlc → paplay
const PLAYERS = [
	{ cmd: "mpv", args: ["--no-video", "--no-terminal", "--volume=80"] },
	{ cmd: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "quiet", "-volume", "80"] },
	{ cmd: "pw-play", args: ["--volume=0.8"] },
	{ cmd: "cvlc", args: ["--play-and-exit", "--no-osd", "--volume", "204"] },
	{ cmd: "paplay", args: [] },
];

// 选择第一个可用的播放器（缓存结果，避免每次检测）
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

// 播放提示音（后台播放，不阻塞）
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

// 桌面通知 + 提示音（fire-and-forget，不阻塞事件循环）
function notify(message: string, status: "完成" | "失败" = "完成") {
	const title = status === "失败" ? "❌ 任务失败" : "✅ 任务完成";
	const urgency = status === "失败" ? "critical" : "normal";

	// KDE/Wayland 下 notify-send 需要 DBus 与显示环境
	const env = {
		...process.env,
		DISPLAY: process.env.DISPLAY || ":0",
		WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
	};

	// 弹窗（5 秒后自动消失）
	execFile("notify-send", ["-u", urgency, title, message, "-t", "5000"], { env }, () => {});

	// 提示音
	if (process.env.PI_NO_NOTIFY !== "1") {
		playChime(env);
	}
}

// 读取阈值：环境变量 > 配置文件 > 默认 0（每次都通知）
function loadThreshold(): number {
	const env = process.env.PI_NOTIFY_THRESHOLD;
	if (env !== undefined && env !== "") {
		const v = parseFloat(env);
		if (!isNaN(v) && v >= 0) return v;
	}
	try {
		const data = JSON.parse(readFileSync(CONFIG, "utf-8"));
		const v = parseFloat(data.thresholdSeconds);
		if (!isNaN(v) && v >= 0) return v;
	} catch { /* 无配置文件或格式错误，忽略 */ }
	return 0;
}

// 持久化阈值到配置文件
function saveThreshold(seconds: number) {
	try {
		writeFileSync(CONFIG, JSON.stringify({ thresholdSeconds: seconds }, null, 2) + "\n", "utf-8");
	} catch { /* 写入失败不影响运行 */ }
}

export default function taskCompleteNotify(pi: ExtensionAPI) {
	// 耗时阈值（秒）：0 = 每次回复都通知；可通过 PI_NOTIFY_THRESHOLD 环境变量或 /notify-threshold 命令调整
	let thresholdSeconds = loadThreshold();
	let runStart: number | null = null;

	// 计时起点：agent run 开始
	pi.on("agent_start", async () => {
		runStart = Date.now();
	});

	// 核心：回复完全结束（无重试/压缩/后续）后，超过阈值才通知
	pi.on("agent_settled", async (_event, _ctx) => {
		const elapsedSec = runStart ? (Date.now() - runStart) / 1000 : 0;
		runStart = null;
		if (elapsedSec < thresholdSeconds) return; // 未超阈值，不通知
		notify(elapsedSec > 0 ? `Pi 已完成回复（耗时 ${elapsedSec.toFixed(1)}s）` : "Pi 已完成回复");
	});

	// 运行时调整阈值：/notify-threshold <秒>，无参数时显示当前值
	pi.registerCommand("notify-threshold", {
		description: "设置通知触发耗时阈值（秒），0 = 每次回复都通知",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify(`当前通知阈值：${thresholdSeconds}s（用法：/notify-threshold <秒>）`, "info");
				return;
			}
			const v = parseFloat(input);
			if (isNaN(v) || v < 0) {
				ctx.ui.notify(`无效值：${input}（请输入非负秒数，0 = 每次都通知）`, "error");
				return;
			}
			thresholdSeconds = v;
			saveThreshold(v);
			ctx.ui.notify(`通知阈值已设为 ${v}s（已保存）`, "info");
		},
	});

	// 补充：注册 notify 工具，模型可在特殊场景（如任务失败、长任务）显式调用并自定义描述
	pi.registerTool({
		name: "notify",
		label: "Notify",
		description:
			"发送桌面通知和提示音提醒用户。用于长任务完成或失败时提醒用户，或在需要用户离开屏幕等待结果时使用。",
		parameters: Type.Object({
			message: Type.String({ description: "通知内容" }),
			status: Type.Optional(Type.Union([Type.Literal("完成"), Type.Literal("失败")])),
		}),
		async execute(toolCallId, params) {
			notify(params.message, params.status ?? "完成");
			return {
				content: [{ type: "text", text: "通知已发送" }],
				details: {},
			};
		},
	});
}

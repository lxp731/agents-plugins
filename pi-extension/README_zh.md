# task-complete-notify

Pi 扩展：回复结束时自动桌面通知 + 提示音，支持按回复耗时设置通知阈值。

> 只在你真正需要被提醒的时候通知你。

[![npm version](https://img.shields.io/npm/v/task-complete-notify)](https://www.npmjs.com/package/task-complete-notify)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Pi Extension](https://img.shields.io/badge/Pi-Extension-blue)](https://pi.dev)

## 为什么需要它？

Pi 在终端跑长任务时，你经常切走做别的事。等任务结束再回来看，效率很低。这个扩展会在回复真正完成时弹出桌面通知并播放提示音，让你第一时间知道结果。

### 核心差异点（vs 其他通知扩展）

| 特性 | task-complete-notify | 其他通知扩展 |
|------|---------------------|-------------|
| 可配置时长阈值 | ✅ 只通知超过 N 秒的任务 | ❌ 通常全部通知 |
| 模型主动调用 notify | ✅ 支持成功/失败状态 | 部分支持 |
| 中文状态支持 | ✅ "完成" / "失败" | ❌ |
| 多播放器自动检测 | ✅ mpv/ffplay/pw-play/cvlc/paplay | 较少 |
| 平台 | 目前 Linux | 视具体项目而定 |

## 安装

```bash
pi install npm:task-complete-notify
# 或
pi install git:github.com/lxp731/task-complete-notify
```

> **平台**：目前仅支持 Linux 桌面环境（需要 `notify-send` + D-Bus 通知服务）。

## 配置

| 方式 | 用法 | 优先级 |
|------|------|--------|
| 环境变量 | `export PI_NOTIFY_THRESHOLD=60` | 最高（单次启动） |
| 命令 | `/notify-threshold 60` | 持久化到 config.json |
| 默认 | 0 = 每次都通知 | 最低 |

**禁用自动通知**：设一个极大的阈值即可，例如 `9999` 秒：

```bash
export PI_NOTIFY_THRESHOLD=9999     # 单次启动禁用
/notify-threshold 9999              # 持久化禁用（config.json）
```

**静音**（弹窗 + 提示音全关）：

```bash
export PI_NO_NOTIFY=1
```

## 使用方式

### 自动通知

安装后开箱即用——每次 Agent 回复结束（`agent_settled` 事件）时自动弹窗 + 播放提示音。默认阈值 `0`，即每次回复都通知。通过阈值控制只对长任务提醒：

```bash
/notify-threshold 30    # 回复超过 30 秒才通知
/notify-threshold       # 查看当前阈值
```

### 显式调用

模型可在任务失败或长任务完成时主动调用 `notify` 工具发送通知：

```
notify(message: "数据导出完成，共 10 万条记录", status: "完成")
notify(message: "构建失败：TypeScript 编译错误", status: "失败")
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 通知内容 |
| `status` | `"完成"` / `"失败"` | 否 | 默认为 `"完成"`，决定弹窗标题和图标 |

## 常见问题

**Q: 为什么没有弹出通知？**

1. 确认系统已安装 `libnotify`（`notify-send` 命令可用）
2. 桌面环境需支持 D-Bus 通知（GNOME、KDE、XFCE 等）
3. 没有设置 `PI_NO_NOTIFY=1`
4. 如果设置了阈值，确认任务实际耗时已超过阈值

**Q: 只有弹窗没有声音？**

扩展会按顺序尝试 mpv → ffplay → pw-play → cvlc → paplay。请至少安装其中一个（推荐 `mpv`）。

**Q: 如何临时关闭通知？**

`export PI_NO_NOTIFY=1` 或设置一个很大的阈值（如 `9999`）。

**Q: 支持 macOS / Windows 吗？**

当前版本仅支持 Linux。macOS 和 Windows 支持在规划中。

## 依赖

- 桌面通知：`notify-send`（libnotify）
- 提示音：`mpv`（或 ffplay / pw-play / cvlc / paplay 任一）
- Linux 桌面环境（D-Bus 通知服务）

## 目录结构

```
extensions/
├── index.ts            # 主程序
└── assets/
    └── prompt-tone.mp3 # 提示音
```

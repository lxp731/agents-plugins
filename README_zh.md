# task-complete-notify

Pi extension: 每次回复结束时通过桌面弹窗（notify-send）+ 提示音提醒用户，支持按回复耗时设置通知阈值。

## 功能

- 每次回复完全结束后自动弹窗 + 播放提示音
- 耗时阈值控制：回复超过 N 秒才通知
- 支持失败/完成状态（模型可显式调用 notify 工具）
- 播放器自动检测：mpv → ffplay → pw-play → cvlc → paplay

## 安装

```bash
pi install npm:task-complete-notify
# 或
pi install git:github.com/lxp731/task-complete-notify
```

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

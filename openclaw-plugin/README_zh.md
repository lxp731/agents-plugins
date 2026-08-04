# task-complete-notify

OpenClaw 插件：Agent 回复完成时弹出桌面通知 + 提示音，支持可配置的耗时阈值。

> 只在真正需要提醒的时候才通知你。  
> 从 [Pi 扩展](https://github.com/lxp731/task-complete-notify) 移植而来。

## 为什么需要它？

OpenClaw 执行长任务时，你通常会切到别处做其他事。反复回来检查浪费时间。这个插件在 Agent 每次回复结束时弹出桌面通知 + 提示音，让你第一时间知道——不用来回检查。

## 安装

### 本地开发

```bash
cd /path/to/task-complete-notify
openclaw plugins install --link .
```

### 从 ClawHub 安装（发布后）

```bash
openclaw plugins install clawhub:task-complete-notify
```

## 配置

安装后，启用插件并开启对话访问权限（`agent_end` hook 需要）：

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    allow: ["task-complete-notify"],
    entries: {
      "task-complete-notify": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        config: {
          thresholdSeconds: 30,   // 可选：仅当耗时超过 30 秒才通知
          // noNotify: true,       // 可选：禁用所有自动通知
        },
      },
    },
  },
}
```

然后重启：

```bash
openclaw gateway restart
```

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `thresholdSeconds` | number | `0` | 最小触发通知的耗时（秒）。0 = 每次都通知。 |
| `noNotify` | boolean | `false` | 禁用所有自动通知（模型仍可调用 `notify` 工具）。 |

## 使用方式

### 自动通知

配置完成后开箱即用——Agent 回复结束时，如果耗时超过 `thresholdSeconds`，自动弹出桌面通知 + 播放提示音。

### 显式调用

模型可以主动调用 `notify` 工具：

```
notify(message: "数据导出完成：100,000 条记录", status: "完成")
notify(message: "构建失败：TypeScript 编译错误", status: "失败")
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是 | 通知内容 |
| `status` | `"完成"` / `"失败"` | 否 | 默认为 `"完成"` |

## 特性

| 特性 | task-complete-notify |
|------|---------------------|
| 可配置耗时阈值 | ✅ 仅当任务超过 N 秒才通知 |
| 模型可调用的 `notify` 工具 | ✅ 支持成功/失败状态 |
| 多播放器自动探测 | ✅ mpv / ffplay / pw-play / cvlc / paplay |
| 中文状态显示 | ✅ "完成" / "失败" |
| 平台 | Linux（需 D-Bus + notify-send） |

## 依赖

- **桌面通知**：`notify-send`（libnotify）
- **音频播放**：`mpv`（推荐）/ ffplay / pw-play / cvlc / paplay
- **桌面环境**：Linux + D-Bus 通知服务

## 常见问题

**Q: 为什么不弹通知？**

1. 确保 `notify-send` 已安装：`sudo pacman -S libnotify`（Arch）/ `sudo apt install libnotify-bin`（Debian）
2. 桌面环境需支持 D-Bus 通知（GNOME、KDE、XFCE 等）
3. 检查配置中 `noNotify` 是否为 `true`
4. 如果设置了 `thresholdSeconds`，确认任务确实超过了阈值

**Q: 弹窗正常，但没声音？**

安装至少一个播放器：`mpv`（推荐）、`ffplay`、`pw-play`、`cvlc`、`paplay`。

**Q: 如何临时关闭通知？**

在插件配置中设置 `noNotify: true`。

**Q: 支持 macOS / Windows 吗？**

暂不支持。目前仅限 Linux。

## 构建与发布

```bash
npm install
npm run build
# 打包测试
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/task-complete-notify-2.0.0.tgz --force
```

发布前注意将 `package.json` 中的 `openclaw.extensions` 改为 `["./dist/index.js"]`。

## 许可证

MIT

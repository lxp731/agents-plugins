# task-complete-notify

OpenClaw plugin: desktop notification + chime when agent finishes a turn, with configurable duration threshold.

> Only notifies when you actually need to be reminded.  
> Adapted from [Pi extension](https://github.com/lxp731/task-complete-notify).

## Why?

When OpenClaw runs a long task, you often switch away. This plugin pops a desktop notification + chime the moment a turn finishes, so you know immediately — without checking back unnecessarily.

### What sets it apart

| Feature | task-complete-notify | 
|---------|---------------------|
| Configurable duration threshold | ✅ Only notify on tasks > N seconds |
| Model-callable `notify` tool | ✅ Success/failure status |
| Multi-player auto-detection | ✅ mpv / ffplay / pw-play / cvlc / paplay |
| Chinese status support | ✅ "完成" / "失败" |
| Platform | Linux (requires D-Bus + notify-send) |

## Install

### Local development

```bash
cd /path/to/task-complete-notify
openclaw plugins install --link .
```

### From ClawHub (once published)

```bash
openclaw plugins install clawhub:task-complete-notify
```

## Configuration

After installing, enable the plugin and allow conversation access (required for `agent_end` hook):

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
          thresholdSeconds: 30,   // optional: only notify if turn took >30s
          // noNotify: true,       // optional: disable all notifications
        },
      },
    },
  },
}
```

Then restart:

```bash
openclaw gateway restart
```

### Config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `thresholdSeconds` | number | `0` | Minimum task duration to trigger notification. 0 = always notify. |
| `noNotify` | boolean | `false` | Disable all auto-notifications (model can still call `notify` tool). |

## Usage

### Automatic Notification

Works out of the box once configured — fires a desktop notification + chime when agent finishes a turn, if the turn exceeded `thresholdSeconds`.

### Explicit Invocation

The model can call the `notify` tool directly:

```
notify(message: "数据导出完成：100,000 条记录", status: "完成")
notify(message: "构建失败：TypeScript 编译错误", status: "失败")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Notification content |
| `status` | `"完成"` / `"失败"` | No | Defaults to `"完成"` |

## Dependencies

- **Desktop notification**: `notify-send` (libnotify)
- **Audio**: `mpv` (or ffplay / pw-play / cvlc / paplay)
- **Desktop**: Linux with D-Bus notification service

## FAQ

**Q: Why no notification pops up?**

1. `notify-send` must be installed: `sudo pacman -S libnotify` (Arch) / `sudo apt install libnotify-bin` (Debian)
2. Your desktop must support D-Bus notifications (GNOME, KDE, XFCE, etc.)
3. Check `noNotify` is not `true` in config
4. If `thresholdSeconds` is set, confirm the task took longer than the threshold

**Q: I see the popup but hear no sound?**

Install at least one of: `mpv` (recommended), `ffplay`, `pw-play`, `cvlc`, `paplay`.

**Q: How do I temporarily turn off notifications?**

Set `noNotify: true` in plugin config.

**Q: Does it support macOS / Windows?**

Not yet. Currently Linux only.

## Building for publishing

```bash
npm install
npm run build
# Then pack and test:
npm pack --pack-destination /tmp
openclaw plugins install npm-pack:/tmp/task-complete-notify-2.0.0.tgz --force
```

Note: update `openclaw.extensions` in package.json to `["./dist/index.js"]` before publishing.

## License

MIT

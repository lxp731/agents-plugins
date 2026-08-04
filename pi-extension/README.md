# task-complete-notify

Pi extension: desktop notification + chime when a reply finishes, with configurable duration threshold.

> Only notifies when you actually need to be reminded.

[![npm version](https://img.shields.io/npm/v/task-complete-notify)](https://www.npmjs.com/package/task-complete-notify)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Pi Extension](https://img.shields.io/badge/Pi-Extension-blue)](https://pi.dev)

## Why?

When Pi runs a long task in the terminal, you often switch away to do something else. Coming back to check repeatedly wastes time. This extension pops a desktop notification + chime the moment a reply settles, so you know immediately.

### What sets it apart

| Feature | task-complete-notify | Other notifiers |
|---------|---------------------|-----------------|
| Configurable duration threshold | ✅ Only notify on tasks > N seconds | ❌ Usually always notify |
| Model-callable notify tool | ✅ Success/failure status | Partially |
| Chinese status support | ✅ "完成" / "失败" | ❌ |
| Multi-player auto-detection | ✅ mpv/ffplay/pw-play/cvlc/paplay | Fewer |
| Platform | Currently Linux | Depends |

## Install

```bash
pi install npm:task-complete-notify
# or
pi install git:github.com/lxp731/task-complete-notify
```

> **Platform**: currently Linux only (requires `notify-send` + D-Bus notification service).

## Configuration

| Method | Usage | Priority |
|--------|-------|----------|
| Env var | `export PI_NOTIFY_THRESHOLD=60` | Highest (per session) |
| Command | `/notify-threshold 60` | Persisted to config.json |
| Default | 0 = always notify | Lowest |

**Disable auto-notify**: set a very large threshold, e.g. `9999` seconds:

```bash
export PI_NOTIFY_THRESHOLD=9999     # per session
/notify-threshold 9999              # persisted (config.json)
```

**Mute** (no popup, no chime):

```bash
export PI_NO_NOTIFY=1
```

## Usage

### Automatic Notification

Works out of the box — fires a desktop notification + chime on every `agent_settled` event. Default threshold is `0` (always notify). Adjust to only alert on long-running tasks:

```bash
/notify-threshold 30    # only notify if reply took >30s
/notify-threshold       # show current threshold
```

### Explicit Invocation

The model can call the `notify` tool to send a notification for important events like task failure or long-running task completion:

```
notify(message: "Data export complete: 100,000 records", status: "完成")
notify(message: "Build failed: TypeScript compilation error", status: "失败")
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Notification content |
| `status` | `"完成"` / `"失败"` | No | Defaults to `"完成"`; determines popup title and icon |

## FAQ

**Q: Why no notification pops up?**

1. Make sure `libnotify` is installed (`notify-send` command is available)
2. Your desktop must support D-Bus notifications (GNOME, KDE, XFCE, etc.)
3. Check `PI_NO_NOTIFY` is not set to `1`
4. If a threshold is set, confirm the task actually took longer than the threshold

**Q: I see the popup but hear no sound?**

The extension tries players in order: mpv → ffplay → pw-play → cvlc → paplay. Install at least one (recommended: `mpv`).

**Q: How do I temporarily turn off notifications?**

`export PI_NO_NOTIFY=1` or set a huge threshold like `9999`.

**Q: Does it support macOS / Windows?**

Not yet. Currently Linux only. Cross-platform support is on the roadmap.

## Dependencies

- Desktop notification: `notify-send` (libnotify)
- Audio: `mpv` (or ffplay / pw-play / cvlc / paplay)
- Linux desktop environment (D-Bus notification service)

## Directory Structure

```
extensions/
├── index.ts            # main entry
└── assets/
    └── prompt-tone.mp3 # notification chime
```

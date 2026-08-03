# task-complete-notify

Pi extension: desktop notification + chime when a reply finishes, with configurable duration threshold.

## Features

- Desktop popup + chime after every reply completes
- Duration threshold: notify only when reply exceeds N seconds
- Supports success/failure status (model can explicitly call the `notify` tool)
- Auto-detects audio player: mpv → ffplay → pw-play → cvlc → paplay

## Install

```bash
pi install npm:task-complete-notify
# or
pi install git:github.com/lxp731/task-complete-notify
```

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

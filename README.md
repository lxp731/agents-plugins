# Agents Plugins

Plugins and skills for AI coding agents (DSH, OpenClaw, Pi).

| Directory | Type | Platform | Registry | Install |
|-----------|------|----------|----------|---------|
| `dsh-service-control/` | Plugin | DSH | npm | `dsh plugin --profile web add dsh-service-control` |
| `task-complete-notify-for-dsh/` | Plugin | DSH | — | `dsh plugin --profile web add github:lxp731/task-complete-notify-for-dsh` |
| `task-complete-notify-for-pi/` | Plugin | Pi Coding Agent | npm | `pi install npm:task-complete-notify` |
| `exit-command-for-pi/` | Plugin | Pi Coding Agent | npm | `pi install npm:exit-command-for-pi` |
| `task-complete-notify-for-openclaw/` | Plugin | OpenClaw | ClawHub | `openclaw plugins install clawhub:task-complete-notify` |
| `edge-tts-for-openclaw/` | Plugin | OpenClaw | ClawHub | `openclaw plugins install clawhub:edge-tts-for-oc` |
| `idcard-a4-pdf/` | Skill | — | — | ID card photos → cropped, perspective-corrected, laid out at real size on an A4 PDF |
| `spotify-cachyos-linux/` | Skill | — | — | `openclaw skills install @lxp731/spotify-cachyos-linux` |

## License

MIT

# Edge TTS for OpenClaw

OpenClaw plugin: voice replies using Microsoft Edge TTS via `edge-tts` CLI.

> Natural-sounding Chinese/English speech synthesis for your AI agent.

## Why?

Text is great, but sometimes you want to hear your agent's replies. This plugin synthesizes OpenClaw's responses using Microsoft Edge's neural TTS engine via `edge-tts` — no API key required.

> ⚠️ **Privacy**: reply text is sent to Microsoft's Edge TTS cloud service for synthesis. Do not use this plugin if your agent handles sensitive or private information.

## Features

| Feature | Description |
|---------|-------------|
| Auto-speak mode | Automatically speak every reply (`always` mode) |
| Model-triggered | Model calls `speak` tool on demand (`auto` mode) |
| Configurable voice | Any Edge TTS voice (300+ voices across 100+ languages) |
| Text cleaning | Strips markdown, code blocks, emoji for natural speech |
| Multi-player auto-detect | ✅ mpv / ffplay / pw-play / cvlc / paplay |
| Playback volume | 100% for mpv / ffplay / cvlc (pw-play & paplay follow system volume) |
| Platform | Linux |

## Install

### Prerequisites

```bash
pip install edge-tts
# Audio player (install at least one)
sudo pacman -S mpv       # recommended
# or: ffplay / pipewire / vlc / pulseaudio
```

### Local development

```bash
cd /path/to/edge-tts-for-openclaw
npm install
openclaw plugins install --link .
```

### From ClawHub (once published)

```bash
openclaw plugins install clawhub:edge-tts-for-oc
```

## Configuration

After installing, enable the plugin:

```json5
// ~/.openclaw/openclaw.json
{
  plugins: {
    allow: ["edge-tts-for-oc"],
    entries: {
      "edge-tts-for-oc": {
        enabled: true,
        config: {
          voice: "zh-CN-YunxiaNeural",  // default voice
          autoSpeak: "auto",             // "always" | "auto"
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

### ⚠️ Expose the `speak` tool to the model

OpenClaw gates plugin tools behind its tool policy. If your config sets `tools.profile` to an allowlist profile (for example the default `coding`), the plugin's `speak` tool is **not visible to the model** until you explicitly allow it:

```json5
{
  tools: {
    profile: "coding",
    alsoAllow: ["speak"], // expose the plugin's speak tool
  },
}
```

Alternatively, add it via CLI:

```bash
openclaw config set tools.alsoAllow '["speak"]' --strict-json --merge
```

> If `tools.profile` is unset or `full`, the `speak` tool is exposed automatically and no `alsoAllow` entry is needed.

### Config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `voice` | string | `zh-CN-YunxiaNeural` | Edge TTS voice name. List voices: `edge-tts --list-voices` |
| `autoSpeak` | `"always"` \| `"auto"` | `"auto"` | `always`: speak every reply. `auto`: only speak when model calls the `speak` tool. |

## Usage

### Auto-speak mode (`always`)

Every reply is automatically spoken aloud.

### Manual mode (`auto`)

The model can call the `speak` tool to read text aloud:

```
speak(text: "构建成功！所有测试通过。")
```

### Listing available voices

```bash
edge-tts --list-voices | grep -i zh-CN
```

## Dependencies

- **TTS engine**: `edge-tts` (Python package)
- **Audio playback**: `mpv` (recommended), or ffplay / pw-play / cvlc / paplay
- **Desktop**: Linux

## Privacy

This plugin sends reply text to Microsoft's Edge TTS cloud service (`edge-tts` CLI) for speech synthesis. No text is logged or stored locally. If your agent handles sensitive or private content, disable auto-speak or avoid this plugin.

## License

MIT

# Edge TTS for OpenClaw

OpenClaw plugin: voice replies using Microsoft Edge TTS via `edge-tts` CLI.

> Natural-sounding Chinese/English speech synthesis for your AI agent.

## Why?

Text is great, but sometimes you want to hear your agent's replies. This plugin synthesizes OpenClaw's responses using Microsoft Edge's neural TTS engine — no API key required, entirely local via `edge-tts`.

## Features

| Feature | Description |
|---------|-------------|
| Auto-speak mode | Automatically speak every reply (`always` mode) |
| Model-triggered | Model calls `speak` tool on demand (`auto` mode) |
| Configurable voice | Any Edge TTS voice (300+ voices across 100+ languages) |
| Text cleaning | Strips markdown, code blocks, emoji for natural speech |
| Platform | Linux (requires `edge-tts` + `mpv`) |

## Install

### Prerequisites

```bash
pip install edge-tts
# Audio player (mpv recommended)
sudo pacman -S mpv
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
- **Audio playback**: `mpv` (required)
- **Desktop**: Linux

## License

MIT

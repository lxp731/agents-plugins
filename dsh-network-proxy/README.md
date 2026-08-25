# dsh-network-proxy

DeepSeek Harness (DSH) 的网络代理管理插件。为用户提供图形化设置界面，可随时切换
**跟随系统 / 手动代理 / 直连** 三种网络出口模式，修改后立即生效。

> Network proxy management plugin for DeepSeek Harness. Switch between
> **system / manual / direct** proxy modes from the settings UI, applied live.

## ✨ 功能特性

- **三种模式**
  - `system` 跟随系统：自动读取系统代理（Windows 读取注册表 `Internet Settings`；其他平台读取 `HTTP(S)_PROXY` 环境变量），无需手动配置。
  - `manual` 手动代理：填写一个 HTTP/HTTPS 代理地址（如 `http://127.0.0.1:7890`）即可生效。
  - `direct` 直连：清空所有代理环境变量，强制直连。
- **即时生效**：设置变更通过 DSH 的 live settings 机制实时应用，无需重启。
- **多协议支持**：基于 [`undici`](https://github.com/nodejs/undici) 的 `ProxyAgent` / `EnvHttpProxyAgent` 接管全局 `Dispatcher`，对 `fetch` 与 `undici` 请求统一生效。
- **Windows 系统代理解析**：正确解析 `ProxyServer` 的 `http=...;https=...` 多协议写法与 `ProxyOverride`（`NO_PROXY`）。
- **双语界面**：内置中文 / 英文文案，跟随 DSH 语言环境自动切换。

## 📦 系统要求

| 依赖 | 版本 |
| --- | --- |
| Node.js | >= 20.18.1（由 `undici@7` 要求） |
| DeepSeek Harness | 支持 DSH 插件与 `settings` / `client` 注入的运行环境 |
| `@deepseek-ai/dsh-settings` | `0.1.0-rc.7` |
| `@deepseek-ai/schemastery` | `3.18.1` |

## 🚀 安装

将本仓库作为 DSH 插件加入你的 Harness 配置（具体方式取决于你使用的 DSH 发行版 / 插件加载器）：

```bash
npm install dsh-network-proxy
```

插件通过 `cordis.patch.yml` 注入 `network-proxy` 插件点，并在客户端 `settings.general.item`
插槽注册「网络代理」设置项。

## ⚙️ 配置项

插件在 `network-proxy` 命名空间下提供以下设置：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `system` \| `manual` \| `direct` | `system` | 代理模式 |
| `url` | `string` | `""` | 手动模式下的代理地址（须为 `http(s)://` URL） |

当用户选择「手动代理」时，URL 会经过校验：必须是合法的 `http://` 或 `https://` 地址，
否则保存会被拒绝并提示错误。

## 🧪 开发 & 测试

```bash
npm install
npm test          # node --test index.test.js
```

测试覆盖 Windows 代理字符串解析、显式 scheme 保留、以及（仅在 Windows 平台）读取
活动系统代理的逻辑。

## 📁 目录结构

```
dsh-network-proxy/
├── index.js            # 服务端插件：代理 Dispatcher 管理与环境变量注入
├── client.js           # Web 客户端：设置界面 UI 与状态管理
├── cordis.patch.yml    # cordis 插件注入声明
├── package.json
├── package-lock.json
└── index.test.js       # 单元测试
```

## 📄 License

[MIT](./LICENSE) © 2026 Kirskite

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the server plugin,
web client, and cordis patch fit together.

## FAQ

**Q: Why does manual mode reject my URL?**
A: The URL must start with `http://` or `https://`; anything else is rejected before save.

**Q: Does direct mode affect the system proxy?**
A: No — it only clears the environment variables DSH reads; your OS proxy setting is untouched.

# dsh-network-proxy

DSH (DeepSeek Harness) 的网络代理管理插件：在设置界面随时切换 **跟随系统 / 手动代理 / 直连**
三种网络出口模式，修改后立即生效，无需重启。

## 功能

| 特性 | 说明 |
|---|---|
| **跟随系统** `system` | Windows 读取注册表 `Internet Settings`（服务账户部署下自动解析**交互用户**的配置）；其他平台读取 `HTTP(S)_PROXY` 环境变量 |
| **手动代理** `manual` | 填写一个 `http(s)://` 代理地址即生效；也接受省略 scheme 的 `host:port` 简写（自动补全 `http://`） |
| **直连** `direct` | 清空所有代理环境变量，强制直连（不触碰系统代理设置） |
| **即时生效** | 通过 DSH live settings 实时应用，无需重启 |
| **多协议统一** | 基于 undici 的 `ProxyAgent` / `EnvHttpProxyAgent` 接管全局 Dispatcher，对 `fetch` 与 undici 请求统一生效 |
| **双语界面** | 内置中文 / 英文文案，跟随 DSH 语言环境自动切换 |

## 安装

```bash
npm install dsh-network-proxy
```

或从 monorepo 以 `#path:` 方式安装：

```bash
dsh plugin --profile web add github:lxp731/agents-plugins#path:/dsh-network-proxy
```

安装后重启 `dsh web`，在 设置 → 常规 中即可看到「网络代理」设置项。

## 配置

插件在 `network-proxy` 命名空间下提供两个字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `mode` | `system` \| `manual` \| `direct` | `system` | 代理模式 |
| `url` | `string` | `""` | 手动模式下的代理地址（`http(s)://` 或 `host:port`） |

手动模式示例：

```json
{ "network-proxy": { "mode": "manual", "url": "http://127.0.0.1:7890" } }
```

## 机制

- **服务端**（`lib/index.js`）：从 live settings 监听 `network-proxy` 命名空间，按模式
  构建并切换全局 undici Dispatcher，同步注入/清理代理环境变量。
  - `system`：Windows 下用 PowerShell 读取注册表；进程身份与服务账户不同（如
    NSSM/LocalSystem 部署）时，优先读取交互用户的 `HKEY_USERS\<sid>` 配置。
  - `manual`：`mode` + `url` 由 Web UI 在同一次 `settings.mutate` 原子提交，
    空 URL 不会触发服务端校验拒绝。
  - `direct`：仅清理 DSH 进程内的代理环境变量，OS 代理设置不受影响。
- **客户端**（`lib/client.js`）：注册 `settings.general.item` 插槽，渲染代理模式
  切换与手动地址输入；首次切到手动模式时先出现输入框，提交时模式与地址一起生效。

## 开发 & 测试

```bash
npm install
npm test          # node --test test/*.test.mjs
```

测试覆盖：手动地址校验（空值 / 不可解析 / 非 http(s) / `host:port` 简写）、Windows
代理字符串解析（多协议写法、显式 scheme 保留、https 回退）、以及（仅 Windows 平台）
读取活动系统代理的逻辑。

## 目录结构

```
dsh-network-proxy/
├── lib/index.js        # 服务端插件：代理 Dispatcher 管理与环境变量注入
├── lib/client.js       # Web 客户端：设置界面 UI 与状态管理
├── test/index.test.mjs # 单元测试
├── cordis.patch.yml    # cordis 插件注入声明
├── README.md           # 中文说明（英文见 README.en.md）
├── package.json
└── package-lock.json
```

## FAQ

**Q: 手动代理地址被拒绝？**
A: 地址必须是 `http://` 或 `https://`，或可自动补全 `http://` 的 `host:port` 简写；
其余形式会在保存前被拒绝。

**Q: 直连模式会影响系统代理吗？**
A: 不会——它只清空 DSH 读取的代理环境变量，操作系统代理设置不受影响。

**Q: DSH 以 Windows 服务运行（NSSM/LocalSystem），跟随系统失效？**
A: 旧版本读的是进程自身的 `HKCU`（服务账户下是服务自己的配置），会静默退化为直连。
现在会解析交互用户的 `HKEY_USERS\<sid>` 并优先采用；手动模式在任何账户下均可用。

**Q: 从 Web UI 切到手动模式时为什么先出现输入框？**
A: 模式与地址在同一次请求中原子提交，空地址不会触发服务端校验拒绝，所以先让你填地址。

## License

[MIT](./LICENSE) © 2026 七朔

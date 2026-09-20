# dsh-network-proxy

DSH (DeepSeek Harness) 的网络代理管理插件：在设置界面随时切换 **跟随系统 / 手动代理 / 直连**
三种网络出口模式，修改后立即生效，无需重启。

## 功能

| 特性 | 说明 |
|---|---|
| **跟随系统** `system` | 读取 **DSH 启动时继承的环境**（`HTTP(S)_PROXY` 等）；Windows 额外读取注册表 `Internet Settings`（服务账户部署下自动解析**交互用户**的配置），继承值优先 |
| **手动代理** `manual` | 填写一个 `http(s)://` 代理地址即生效；也接受省略 scheme 的 `host:port` 简写（自动补全 `http://`） |
| **直连** `direct` | 安装直连策略并移除代理键，强制直连（不触碰系统代理设置） |
| **即时生效** | 通过 DSH live settings 实时重装进程级代理策略，无需重启 |
| **覆盖 dsh 自身网络** | 与 `dsh-web-fetch-http` 共用 `@deepseek-ai/dsh-http-proxy` 的同一份策略，因此 `web_fetch`、模型 API、`web_search` 等走同一出口 |
| **持久化** | 同步维护 `$DSH_HOME/.env`，下次启动在插件挂载前即生效；只动代理键，其余内容原样保留 |
| **双语界面** | 内置中文 / 英文文案，跟随 DSH 语言环境自动切换 |

## 安装

**从 npm 安装（推荐）：**

```bash
dsh plugin --profile web add dsh-network-proxy
```

**从 GitHub monorepo 安装（备选）：**

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

- **服务端**（`lib/index.js`）：
  - 监听 live settings 的 `network-proxy` 命名空间；每次变更都调用
    `@deepseek-ai/dsh-http-proxy` 的 `installProxyFromEnvironment()` **重新安装进程级代理策略**。
    这正是 `dsh-web-fetch-http` 通过 `proxyRouteFor()` 查询的同一份策略，所以 `web_fetch`
    也会随模式切换（无需重启）。
  - 同时把模式镜像进 `$DSH_HOME/.env`：`manual` 写入 `HTTP_PROXY`/`HTTPS_PROXY`，
    `system`/`direct` 移除代理键。只管理代理键，其它行 / 注释 / 空行原样保留；原子写入、
    权限 `0600`（代理 URL 可能带凭据）。
  - `system`：读取**启动环境快照的 `process` 层**
    （`launchEnvironmentOf(ctx).getFrom(name, ['process'])`），即 dsh 进程真正继承到的环境——
    刻意排除插件自己写进 `.env` 的值。Windows 下再读取注册表，继承值优先。
  - `manual`：`mode` + `url` 由 Web UI 在同一次 `settings.mutate` 原子提交，
    空 URL 不会触发服务端校验拒绝。
- **客户端**（`lib/client.js`）：注册 `settings.general.item` 插槽，渲染代理模式
  切换与手动地址输入；首次切到手动模式时先出现输入框，提交时模式与地址一起生效。

## 开发 & 测试

```bash
npm install
npm test          # node --test test/*.test.mjs
```

测试覆盖：手动地址校验（空值 / 不可解析 / 非 http(s) / `host:port` 简写）、Windows
代理字符串解析（多协议写法、显式 scheme 保留、https 回退）、（仅 Windows 平台）
读取活动系统代理的逻辑，以及**实时策略安装与 `.env` 同步**（手动走代理、直连与
跟随系统清除、跟随系统取启动环境而非插件自己的 `.env`、用户 `.env` 其它行保留）。

> **本地开发提示**：若你以「软链进 profile」的方式开发本插件，请把
> `@deepseek-ai/dsh-http-proxy`、`@deepseek-ai/dsh-launch-environment` 两个 peer
> 在插件的 `node_modules` 下**链接到 harness 的同名包**（而不是各自安装一份）。
> 它们保存着进程级代理策略，必须与 `dsh-web-fetch-http` 共用同一个模块实例，
> 否则插件装的策略 `web_fetch` 看不到。

## 目录结构

```
dsh-network-proxy/
├── lib/index.js        # 服务端插件：实时安装 dsh-http-proxy 策略 + 维护 $DSH_HOME/.env
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
A: 不会——它只在 DSH 进程内安装直连策略并移除插件管理的 `.env` 代理键，
操作系统代理设置不受影响。

**Q: 为什么「跟随系统」取不到我 shell 里 `export` 的代理？**
A: DSH 由 systemd 用户服务启动，不会执行你 shell 的启动脚本（`.zshrc`、oh-my-zsh 等），
所以拿不到只存在于交互 shell 的变量。把代理放进 systemd 用户管理器能读到的地方即可，
例如 `~/.config/environment.d/99-proxy.conf` 写 `HTTP_PROXY=...`（**重新登录**后生效），
或 `systemctl --user set-environment HTTP_PROXY=...` 后重启 `dsh-web`。

**Q: 切换模式会改我的 `$DSH_HOME/.env` 吗？**
A: 会——这是持久化机制，让下次启动在插件挂载前就生效。插件只管理
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`（含小写形式）这几个键，其余内容原样保留；
文件以 0600 原子写入。

**Q: DSH 以 Windows 服务运行（NSSM/LocalSystem），跟随系统失效？**
A: 旧版本读的是进程自身的 `HKCU`（服务账户下是服务自己的配置），会静默退化为直连。
现在会解析交互用户的 `HKEY_USERS\<sid>` 并优先采用；手动模式在任何账户下均可用。

**Q: 从 Web UI 切到手动模式时为什么先出现输入框？**
A: 模式与地址在同一次请求中原子提交，空地址不会触发服务端校验拒绝，所以先让你填地址。

## License

[MIT](./LICENSE) © 2026 七朔

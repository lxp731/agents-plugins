# dsh-service-control

DSH 服务控制：给 `dsh` 命令一对翅膀——通过 **`dsh --profile ctl`** 管理服务的
systemd 生命周期、持久化配置与运行时诊断。不再引入独立命令（旧版 `dshctl` 已废弃）。

## 机制

`dsh` 启动器只解析自己的 flag（`--profile`/`--patch`/`--dump-config`），
**其后的内层参数**原样转交给启动后的应用树。本插件在专用的轻量 **`ctl` profile**
（dsh-base + 插件，无 webserver/agent）里通过 `@deepseek-ai/dsh-cmdline` 接管这些
参数，执行完命令后请求进程退出。每次调用 = 启动一次轻量 profile（约 0.2-0.5s）。

## 安装

```bash
# 首次创建 ctl profile 并安装（ctl 是约定的控制面 profile 名）
dsh plugin --profile ctl add dsh-service-control

# 本地开发安装
dsh plugin --profile ctl add "file:/path/to/agents-plugins/dsh-service-control"
```

> 注意：**不要**把本插件装进 `web` profile——它的命令树会与 web 自身的参数解析冲突。
> 插件只在 ctl 这类无 webserver 的轻量 profile 中生效。

## 命令

```
dsh --profile ctl <namespace> <subcommand> [args]
```

| 命名空间 | 命令 | 功能 |
|---|---|---|
| **self** | `info\|i` | 插件信息：版本、安装来源、目标 profile |
| | `update [--check]` | 自更新：按安装来源升级（link 安装 → git 拉取；快照/registry → 提示重装） |
| **config** | `get [key]` | 查看配置（无 key 列出全部） |
| | `set <key> <value>` | 设置并持久化（白名单键 + 数值校验） |
| **svc** | `doctor\|d` | 一键自检 |
| | `logs [-f]` | 查看 dsh 日志文件 |
| | `probe\|h` | 探测健康（`/dsh-health` 或 `/`，可达性 + 延迟） |
| **systemd** | `install [--env …]` | 安装 unit（服务+看门狗）→ systemd 托管，**不开机自启**；`--env` 携带环境变量 |
| | `reinstall --env …` | 向已安装 unit 追加环境变量（保留用户修改；不自动重启） |
| | `status\|ps` | 运行状态（pid/端口/URL/systemd state） |
| | `start\|up` | 启动（`systemctl start`，就绪后开浏览器） |
| | `stop\|down` | 停止（`systemctl stop`，绝不自动重启） |
| | `restart\|reload` | 重启（`systemctl restart`，不开浏览器） |
| | `enable\|on` | 开机自启（无 unit 时先自动 install） |
| | `disable\|off` | 停看门狗 + 取消自启（**保留 unit 文件**） |
| | `uninstall\|remove` | 删除 unit 文件（撤销托管） |
| | `journal [-f]` | 查看 systemd journal |
| **completions** | `[bash\|zsh\|fish]` | 无参数按检测到的 shell 打印脚本 |
| | `--shell <x>` | 指定 shell |
| | `--write-state` | 缓存全部 shell 脚本到 `$DSH_HOME/completions/dsh.<ext>` |
| | `--write-state --install` | 缓存 + 放入 shell 默认加载目录（不修改 rc） |

**systemd 生命周期分层**：

```
install        = 托管：写 unit + 注册 → 崩溃自愈/看门狗生效，【不开机自启】
reinstall      = 追加环境变量：保留 unit 文件全部内容，仅插入/更新 --env 指定的键
enable         = 托管 + 开机自启（无 unit 时自动先 install）
disable        = 停看门狗 + 取消自启（unit 文件保留，托管仍生效）
uninstall/remove = 撤销托管：删除 unit 文件
```

**`--env` 环境变量**（`install` / `reinstall` 支持，可重复）：

```bash
# 显式传值
dsh --profile ctl systemd install --env OPENROUTER_API_KEY=sk-xxxxx567
# 隐式：从当前 shell 环境取值（未设置或为空 → 安装失败）
dsh --profile ctl systemd install --env OPENROUTER_API_KEY
# 多个变量
dsh --profile ctl systemd install --env A=1 --env B=2
# 向已安装 unit 追加（保留用户手改；已存在的键跳过并提示）
dsh --profile ctl systemd reinstall --env OPENROUTER_API_KEY=sk-xxxxx567
```

环境变量以 `Environment="KEY=value"` 写入主 unit 的 `[Service]` 段
（`$` 原样保留、`%`/引号/反斜杠按 systemd 语法转义）。注意：unit 内的环境变量
对同用户 D-Bus 客户端可见，不适合存放高敏密文；隐式形式 `--env KEY` 可避免
密钥出现在 shell 历史与进程命令行中。`reinstall` 只 `daemon-reload`、**不自动
重启**——新环境变量在下次 `dsh --profile ctl systemd restart` 时生效。

## 被控目标 profile

`ctl` 是控制面，**被控的服务 profile 默认 `web`**。可在 ctl profile 的
`cordis.patch.yml` 中覆盖：

```yaml
- id: dsh-service-control
  config:
    profile: tui
```

## 补全（放入 shell 默认加载目录，不修改 rc 文件）

```bash
dsh --profile ctl completions --install          # 安装全部三个 shell
dsh --profile ctl completions --install bash     # 只装 bash
dsh --profile ctl completions bash               # 只打印脚本（不安装）
dsh --profile ctl completions --write-state      # 缓存到 $DSH_HOME/completions（可选）
```

`--install` 把生成的脚本放进各 shell **默认自动加载目录**，**不修改任何用户的
.zshrc / .bashrc 配置文件**：

| shell | 安装位置 | 自动加载条件 |
|---|---|---|
| bash | `~/.local/share/bash-completion/completions/dsh` | 系统装有 bash-completion（主流发行版默认） |
| zsh | `~/.zsh/completions/_dsh` | `~/.zsh/completions` 在 `$fpath` 中（oh-my-zsh 等框架已包含） |
| fish | `~/.config/fish/completions/dsh.fish` | fish 原生自动加载 |

## 配置键（config set 白名单）

| 键 | 默认 | 功能 |
|---|---|---|
| `DSH_WATCHDOG_INTERVAL` | `3` | 看门狗探测间隔（秒） |
| `DSH_WATCHDOG_FAIL_LIMIT` | `3` | 连续失败次数阈值 |
| `DSH_WATCHDOG_PROBE_TIMEOUT` | `3` | 单次探测超时（秒） |
| `DSH_WATCHDOG_COOLDOWN` | `15` | 看门狗重启后冷却（秒） |
| `DSH_OPEN_CMD` | `xdg-open` | 浏览器打开命令 |
| `DSH_BIN` | `dsh` | dsh 二进制路径（写 unit 时固化） |
| `DSH_LOG` | 按日路径 | 日志文件路径 |
| `DSH_LOG_DIR` | `~/.dsh/logs/dsh` | 日志目录 |

## 平台与依赖

- Linux 为主：`bash`、`systemctl`（可选，无则自启相关命令报错）、`pgrep`/`pkill`、`ss` 或 `lsof`、`curl`。
- macOS 部分支持（`ss`→`lsof` 回退、`probe` 延迟回退 `node`、浏览器回退 `open`）；systemd 命令不可用。
- Windows 需要 WSL。
- 依赖：`@deepseek-ai/dsh-cmdline`、`commander`、`@deepseek-ai/schemastery`（Node ≥ 18）。

## 测试

```bash
npm test        # 单元测试：命令树解析（别名/flag/退出）、completions 生成、
                # control.sh systemd 分层（install/enable/disable/uninstall）、插件形态
npm run smoke   # 冒烟：隔离 profile 安装 → 组合配置断言 → cmdline 通道 self info / systemd status
```

## 卸载

```bash
dsh plugin --profile ctl remove dsh-service-control   # 移除插件本体
rm -rf ~/.dsh/profiles/ctl                            # （可选）删除控制面 profile
dsh --profile ctl systemd uninstall                   # （可选）卸载前先撤销 systemd 托管
```

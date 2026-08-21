# dsh-service-control

DSH 服务启停控制插件：HTTP API 控制启停/重启/状态，附带独立 CLI `dshctl`（含 shell 补全）。无 Web UI 面板。

控制逻辑在进程外（`scripts/control.sh`），插件通过 HTTP 路由调用；重启/停止由独立延迟进程执行，不会卡死插件自身。

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-service-control
# 从 GitHub monorepo 子目录安装
dsh plugin --profile web add github:lxp731/agents-plugins#path:/dsh-service-control
# 本地开发安装（从仓库目录调试时）
# dsh plugin --profile web add "file:."
```

装完重启 web profile 生效（结束当前 `dsh web` / `dsh --profile web` 进程后重新启动）。

> 插件位于 `agents-plugins` monorepo 的 `dsh-service-control/` 子目录，故从
> GitHub 安装需用 `#path:` 指定子目录。


### 启用 CLI 与补全

插件自带 CLI `dshctl`，安装后执行一次 setup 即可：自动链接到 `~/.local/bin/` 并安装补全（zsh/bash/fish 按检测到的 shell 自动选），幂等可重复执行，不改写任何 shell rc。**新开终端**后补全生效：

```bash
dshctl setup
```

如果提示 `dshctl: command not found`（多为 `~/.local/bin` 不在 PATH），直接用包内命令执行 setup 即可，或改用全局安装：

```bash
~/.dsh/profiles/web/node_modules/.bin/dshctl setup   # 包内命令（profile 安装）
npm install -g dsh-service-control                   # 全局安装（npm 全局 bin 默认在 PATH）
```

## 使用

### HTTP API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/dsh-health` | GET | 探活 |
| `/dsh-service/status` | GET | 状态 JSON `{ok, running, pid, port, url, profile, note}`（`port`/`url` 检测不到时为 `null`） |
| `/dsh-service/start` | POST | 后台启动（随后自动打开浏览器标签） |
| `/dsh-service/stop` | POST | 优雅停止（SIGINT，由独立进程执行） |
| `/dsh-service/restart` | POST | 延迟重启（独立进程执行，先休眠 3s 再重启） |

### CLI

```bash
dshctl status                # 状态（已 enable 时附带 [systemd 状态]）
dshctl open                  # 默认浏览器打开服务页面（未运行时提示先 start）
dshctl start                 # 启动（默认 web profile，就绪后自动打开浏览器标签）
dshctl stop web
dshctl restart web
dshctl --profile tui start   # 指定 profile
dshctl enable                # 创建 systemd unit（服务 + 看门狗）并设为开机自启
dshctl disable               # 取消开机自启、停掉看门狗并删除 unit 文件
dshctl enable tui            # 指定 profile
dshctl setup                 # 启用 CLI + 安装补全
dshctl uninstall             # 移除 CLI 链接、补全与 systemd unit
```

## 开机自启与自愈（systemd user units）

`dshctl enable` 写入两个 unit 并 `systemctl --user enable`（均幂等）：

| unit | 作用 |
|---|---|
| `dsh-<profile>.service` | 主服务：`dsh --profile <profile> --no-open`，`Restart=on-failure` + `RestartSec=10`，`KillSignal=SIGINT` |
| `dsh-<profile>-watchdog.service` | 看门狗：进程外每 3s 探测 `/dsh-health`，连续 3 次无响应（约 10s）→ `systemctl --user restart` 主服务 |

**退出原因由 systemd 判定，正常退出绝不重启：**

- 正常退出（退出码 0 / Ctrl+C 的 SIGINT / SIGTERM / `dshctl stop` / `systemctl stop`）→ **不重启**（systemd 视 SIGINT/SIGTERM/exit 0 为干净退出，`systemctl stop` 显式停止更永不触发重启）。
- 异常退出（非零退出码、崩溃信号如 SIGSEGV/SIGABRT/SIGKILL、OOM killer）→ **10s 后自动拉起**。
- 卡死（进程活着但 `/dsh-health` 无响应）→ 看门狗约 10s 后重启；正常停掉的服务 unit 为 inactive，看门狗绝不会碰它。

已 enable 后 `dshctl start/stop/restart/status` 自动走 `systemctl --user`（保证生命周期一致，避免手动 pkill 与 systemd 自动重启打架）；未 enable 时仍是原始进程控制。`dshctl disable` 会先停掉看门狗，再取消自启并删除两个 unit 文件。

- 日志：`journalctl --user -u dsh-<profile>`、`journalctl --user -u dsh-<profile>-watchdog`。
- 无 systemd 环境（容器/未启用 systemd 的 WSL）会报错；无图形会话的开机自启可先 `loginctl enable-linger`。
- enable 时若 dsh 正在 systemd 之外运行，会提示先 `dshctl stop` 再 `dshctl start` 迁入 systemd 托管。

## 配置

插件 Config 支持 `profile`：指定控制哪个 profile，默认取启动 dsh 时的 `--profile` 参数（否则 `web`）。在 profile 的 `cordis.patch.yml` 或 `--patch` overlay 中按 id 覆盖该行（`config` 为整体替换）：

```yaml
- id: dsh-service-control
  config:
    profile: tui
```

## 测试

```bash
npm test        # 单元测试：插件形态 / Config / inject / patch 行
npm run smoke   # smoke test：隔离 profile 安装 → 组合配置断言 → 启动 → /dsh-health 探测（无 dsh CLI 时自动跳过）
```

## 卸载

```bash
dshctl uninstall             # ① 删 CLI 链接 + 三处补全 + systemd 开机自启 unit
dsh plugin --profile web remove dsh-service-control   # ② 移除插件本体（多 profile 逐一执行）
重启 web profile 生效        # ③ 结束当前 dsh web 进程后重新启动
```

`dshctl uninstall` 会扫描 `~/.config/systemd/user/`，自动检测并删除 `dshctl enable` 创建的 unit（`dsh-<profile>.service`，含本插件模板签名；仅删除我们自己的文件，同名但非本插件的 unit 保留）：先 `systemctl --user disable`，再删除文件并 `daemon-reload`。

可选残留：`/tmp/dsh-web.log` 日志。

> 崩溃自动拉起需进程外机制（插件在进程死亡时无法自救），建议配合 systemd user service 使用。

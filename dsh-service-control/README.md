# dsh-service-control

DSH 服务启停控制插件：HTTP API 控制启停/重启/状态，附带独立 CLI `dshctl`（含 shell 补全）。无 Web UI 面板。

控制逻辑在进程外（`scripts/control.sh`），插件通过 HTTP 路由调用；重启/停止由独立延迟进程执行，不会卡死插件自身。

## 安装

```bash
# 从 npm 安装（推荐）
dsh plugin --profile web add dsh-service-control
# 本地开发安装（从仓库目录调试时）
# dsh plugin --profile web add "file:."
```

装完重启 web profile 生效（结束当前 `dsh web` / `dsh --profile web` 进程后重新启动）。

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
| `/dsh-service/start` | POST | 后台启动 |
| `/dsh-service/stop` | POST | 优雅停止（SIGINT，由独立进程执行） |
| `/dsh-service/restart` | POST | 延迟重启（独立进程执行，先休眠 3s 再重启） |

### CLI

```bash
dshctl status                # 状态
dshctl open                  # 默认浏览器打开服务页面（未运行时提示先 start）
dshctl start                 # 启动（默认 web profile）
dshctl stop web
dshctl restart web
dshctl --profile tui start   # 指定 profile
dshctl setup                 # 启用 CLI + 安装补全
dshctl uninstall             # 移除 CLI 链接与补全
```

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
dshctl uninstall             # ① 删 CLI 链接 + 三处补全
dsh plugin --profile web remove dsh-service-control   # ② 移除插件本体（多 profile 逐一执行）
重启 web profile 生效        # ③ 结束当前 dsh web 进程后重新启动
```

可选残留：`/tmp/dsh-web.log` 日志；若配过 systemd 守护则 `systemctl --user disable --now dsh` 并删单元文件。

> 崩溃自动拉起需进程外机制（插件在进程死亡时无法自救），建议配合 systemd user service 使用。

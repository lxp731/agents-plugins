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

插件附带 CLI `dshctl`。启用分两步：先把 `dshctl` 放进 PATH，再执行 `dshctl setup` 一键链接并安装补全。

**第一步：让 `dshctl` 进 PATH**（任选其一）

```bash
# ① 用包内自带的命令直接执行 setup（最省事，无需手动改 PATH）
#    <profile> 换成实际安装的 profile，如 web
~/.dsh/profiles/<profile>/node_modules/.bin/dshctl setup

# ② npm 全局安装（npm 全局 bin 目录默认已在 PATH）
npm install -g dsh-service-control

# ③ 手动链接到 ~/.local/bin（需 ~/.local/bin 已在 PATH，见下）
ln -s ~/.dsh/profiles/web/node_modules/dsh-service-control/bin/dshctl.js ~/.local/bin/dshctl
```

**第二步：确认 `dshctl` 可用**

```bash
which dshctl   # 应输出 dshctl 的路径
```

若 `which` 找不到但用了方式①的链接路径，多半是 `~/.local/bin` 不在 PATH 中。检查并添加（zsh 写 `~/.zshrc`，bash 写 `~/.bashrc`，然后新开终端或 `source` 生效）：

```bash
echo "$PATH" | tr ':' '\n' | grep -n "$HOME/.local/bin" || echo "not in PATH"
export PATH="$HOME/.local/bin:$PATH"
```

**第三步：一键启用补全**

```bash
dshctl setup
```

`dshctl setup` 自动链接 CLI 到 `~/.local/bin/` 并安装补全（zsh/bash/fish 按检测到的 shell 自动选），幂等可重复执行，不改写任何 shell rc。**新开终端**后补全生效。

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

# 发布到 ClawHub

## 首次发布

```bash
# 1. 进入仓库根目录
cd ~/workspace/agents-plugins

# 2. 安装依赖（首次）
cd task-complete-notify-for-openclaw && npm install && cd ..

# 3. 构建（生成 dist/）
cd task-complete-notify-for-openclaw && npm run build && cd ..

# 4. dry-run
clawhub package publish ./task-complete-notify-for-openclaw \
  --source-repo lxp731/agents-plugins \
  --source-commit $(git rev-parse HEAD) \
  --dry-run

# 5. 正式发布
clawhub package publish ./task-complete-notify-for-openclaw \
  --source-repo lxp731/agents-plugins \
  --source-commit $(git rev-parse HEAD)
```

## 更新版本后重新发布

```bash
cd ~/workspace/agents-plugins

# 1. 更新版本号（两个文件都要改）
#    task-complete-notify-for-openclaw/package.json         → "version": "x.y.z"
#    task-complete-notify-for-openclaw/openclaw.plugin.json → "version": "x.y.z"

# 2. 构建
cd task-complete-notify-for-openclaw && npm run build

# 3. 发布
clawhub package publish . \
  --source-repo lxp731/agents-plugins \
  --source-commit $(git rev-parse HEAD)

## 安装测试

发布后在任何机器上测试：

```bash
openclaw plugins install clawhub:task-complete-notify
```

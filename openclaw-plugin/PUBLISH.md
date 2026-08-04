# 发布到 ClawHub

## 首次发布

```bash
# 1. 进入仓库根目录
cd ~/workspace/task-complete-notify

# 2. 安装依赖（首次）
cd openclaw-plugin && npm install && cd ..

# 3. 构建（生成 dist/）
cd openclaw-plugin && npm run build && cd ..

# 4. dry-run
clawhub package publish ./openclaw-plugin \
  --source-repo lxp731/task-complete-notify \
  --source-commit $(git rev-parse HEAD) \
  --dry-run

# 5. 正式发布
clawhub package publish ./openclaw-plugin \
  --source-repo lxp731/task-complete-notify \
  --source-commit $(git rev-parse HEAD)
```

## 更新版本后重新发布

```bash
cd ~/workspace/task-complete-notify

# 1. 更新版本号（两个文件都要改）
#    openclaw-plugin/package.json         → "version": "x.y.z"
#    openclaw-plugin/openclaw.plugin.json → "version": "x.y.z"

# 2. 构建
cd openclaw-plugin && npm run build && cd ..

# 3. 发布
clawhub package publish ./openclaw-plugin \
  --source-repo lxp731/task-complete-notify \
  --source-commit $(git rev-parse HEAD)

# 4. 提交 tag
git add -A && git commit -m "release: openclaw-plugin vx.y.z"
git tag vx.y.z
git push --tags
```

## 安装测试

发布后在任何机器上测试：

```bash
openclaw plugins install clawhub:task-complete-notify
```

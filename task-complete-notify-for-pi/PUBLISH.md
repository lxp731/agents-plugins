# 发布到 npm

## 首次发布

```bash
# 1. 进入插件目录
cd task-complete-notify-for-pi

# 2. 确认版本号（package.json）
#    "version": "x.y.z"

# 3. 发布
npm publish
```

## 更新版本后重新发布

```bash
cd task-complete-notify-for-pi

# 1. 改 package.json 的 version 字段

# 2. 发布
npm publish
```

## 安装测试

发布后在任意机器上测试：

```bash
pi install npm:task-complete-notify
```

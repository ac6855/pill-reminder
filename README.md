# 用药提醒（Pill Reminder）

一个自托管的用药提醒小服务：**定时推送到微信 + 手机打卡页 + 表格化配置**。

设计上刻意做轻——**零第三方依赖**（只用 Node 内置模块与内置 `node:sqlite`），不需要 `npm install`，
不需要编译原生模块，一个容器跑起来即用。

> 代码仓库中**不包含任何真实用药数据**。所有计划、打卡记录、推送凭据都存在运行时的 SQLite 文件里，
> 由你在配置页自行录入。

## 功能

| 能力 | 说明 |
|---|---|
| 定时推送 | 每分钟检查一次计划表，到点通过 Server 酱 / 企业微信群机器人 / 自定义 Webhook 推送 |
| 打卡页 | 移动端优先，按日期查看待办，点一下即可勾选/取消，显示完成进度与超时标记 |
| 配置表格 | 表格式管理用药计划（时间 / 药品 / 剂量 / 方式 / 备注 / 启用），逐行保存 |
| 隐私模式 | 开启后推送正文不含药品名称，只提示"有待办事项" |
| 推送留档 | 每次推送（含测试）记录结果与失败原因，同一计划同一天同一时间最多尝试 3 次 |
| 数据导出 | 计划表、打卡记录均可导出 CSV |
| 管理口令 | 可选。设置后管理接口需口令，打卡接口不受影响 |

## 快速开始

### 方式一：飞牛 FnOS / NAS 部署（推荐）

仓库带两份 compose，按有没有装 WatchCow 二选一：

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | 标准版。飞牛 Docker「新建项目」直接粘贴，或在目录里 `docker compose up -d` |
| `docker-compose.watchcow.yml` | 装了 WatchCow 的飞牛用它，容器会注册成桌面应用，点开即用 |

镜像由 GitHub Actions 构建并推送到 GHCR，设备上不需要 build：

```
ghcr.io/ac6855/pill-reminder:latest
```

部署完打开：

- 打卡页 `http://NAS_IP:8787/`
- 配置页 `http://NAS_IP:8787/admin.html`

`NAS_IP` 换成 NAS 在局域网中的地址，例如 `192.168.1.20`。

数据落在 `/vol2/1000/Data/pill-reminder/data/app.db`（换机器就改 compose 里那一处路径）。

两点注意：

1. GHCR 在国内经常拉不动，**这是常态不是配置错**。拉不动就把 compose 里的 `image:` 换成
   `pill-reminder:latest`、加一行 `build: .`，再 `docker compose up -d --build`，
   本地构建几秒完成，运行效果完全一致。
2. 镜像包当前是 Public，NAS 免登录可拉；若以后改成私有，需在 NAS 上配 GHCR 登录。

### 方式二：WatchCow 应用化（可选）

装了 WatchCow（`github.com/tf4fun/watchcow`）的飞牛，用 `docker-compose.watchcow.yml`，
容器会以「用药提醒」的名字注册成 FnOS 桌面应用。

- 标签名对应 **WatchCow v0.2+**（`display_name` / `desc` / `service_port` / `appname`）
- 图标走本地文件 `file:///vol2/1000/Data/icons/pill-reminder.png`，需先把仓库里的
  `icons/pill-reminder.png` 传到该位置

### 方式三：本地直接跑（适合开发调试）

要求 Node.js **>= 22.5**（`node:sqlite` 自该版本起内置）。

```bash
node app/server.js
# 或指定端口 / 时区
PORT=8787 TZ=Asia/Shanghai node app/server.js
```

其他可选环境变量：

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `TZ` | `Asia/Shanghai` | 推送判定所用时区 |
| `DB_PATH` | `./data/app.db` | SQLite 文件路径 |
| `GRACE_MINUTES` | `5` | 补推窗口（分钟）。服务在该窗口内重启，仍会补发未成功的提醒 |

## 手机上怎么用

打卡页是移动端优先的，手机浏览器直接开 `http://NAS_IP:8787/`。

- **微信里能打开**：把地址发到「文件传输助手」，点链接；若弹「非微信官方网页」选继续访问。
  微信内置浏览器不存书签，长期用建议走下一条。
- **添加到主屏幕（推荐）**：iPhone 用 Safari → 分享 → 添加到主屏幕；安卓用 Chrome → ⋮ → 添加到主屏幕。
  桌面多一个图标，家人不用教也会点。
- **前提**：在路由器里给 NAS 做 DHCP 地址保留（MAC 绑定），否则路由器重启后 IP 变了，链接就失效。
- **异地访问**：内网地址在外网一定打不开，需要内网穿透（如 Tailscale）或飞牛自带远程访问。
  任何映射到公网的做法，**务必先在配置页设管理口令**，否则管理接口对全网敞开。

## 首次配置

1. 打开配置页 → **用药计划** → 点「+ 新增一行」，逐行填写时间与内容，点该行「保存」
   - 时间格式 24 小时制 `HH:MM`
   - 停用的行不推送、也不计入打卡总数
   - 想先看效果可点 **数据管理 → 载入示例模板**（3 行通用示例，随时可删）
2. 切到 **推送设置**，选择渠道并填凭据：

   **Server 酱（微信）** — 最简单
   - 访问 `https://sctapi.ftqq.com` 微信扫码登录，复制 SendKey（形如 `SCT...`）
   - 填到「SendKey」，勾选「到点自动推送」，保存
   - 想多个人都收到，就各自绑定，分别配置一个实例即可

   **企业微信群机器人**
   - 群里 → 右上角 → 添加群机器人 → 复制 Webhook 地址
   - 填到「企业微信 Webhook」

   **自定义 Webhook**
   - 任意接收 `POST JSON` 的地址，字段为 `{ title, content, time, name }`

3. 点 **发送测试推送**，确认手机能收到；再点「保存设置」
4. 建议在推送设置里设置一个**管理口令**（留空则不校验，仅适合完全可信的局域网）

## 数据与隐私

- 全部数据在 `data/app.db`（SQLite，WAL 模式）。备份 = 复制这个文件；迁移 = 连同文件一起搬走。
- 代码里没有任何真实药品、剂量或个人信息，示例模板也是通用占位。
- **清空所有数据**：配置页 → 数据管理 → 清空全部数据。注意 SQLite 文件本身会保留（体积不会立刻变小）。
- 建议把打卡页和管理页限制在内网。若要暴露到公网，请在前面加一层反向代理并启用 HTTPS，
  同时务必设置管理口令。

## 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 否 | 健康检查，返回当前日期与时间 |
| GET | `/api/day?date=YYYY-MM-DD` | 否 | 某天的计划与打卡状态（默认今天） |
| POST | `/api/checkin` | 否 | 打卡：`{ planId, date?, done }` |
| GET | `/api/plans` | 是 | 计划列表 |
| POST | `/api/plans` | 是 | 新增计划 |
| PUT | `/api/plans/:id` | 是 | 更新计划 |
| PATCH | `/api/plans/:id/enabled` | 是 | 启用 / 停用 |
| DELETE | `/api/plans/:id` | 是 | 删除计划及其打卡记录 |
| GET/PUT | `/api/settings` | 是 | 读取（敏感项脱敏）/ 保存设置 |
| POST | `/api/push/test` | 是 | 发一条测试推送 |
| GET | `/api/logs?limit=100` | 是 | 推送记录 |
| GET | `/api/checkins?limit=5000` | 是 | 打卡记录（导出用） |
| POST | `/api/demo` | 是 | 载入 3 行通用示例 |
| POST | `/api/wipe` | 是 | 清空全部数据 |

鉴权方式：请求头 `x-admin-token: <口令>` 或查询参数 `?token=<口令>`。未设置口令时一律放行。

## 常见问题

**怎么更新到新版本**

`docker compose pull && docker compose up -d`，数据在 `./data` 不受影响。
compose 里刻意没设 `pull_policy: always`：那样断网重启会拉取失败、容器直接起不来，
而这是个每天推 13 次的提醒服务，宁可用旧镜像也要让它活着。

**收不到推送**
先点「发送测试推送」看返回详情，再查「推送日志」。常见原因：SendKey 填错、渠道选错、
Server 酱当日配额用尽、设备所在网络访问不了 `sctapi.ftqq.com`。

**时间对不上**
容器内 `TZ` 必须是 `Asia/Shanghai`（compose 文件已设置）。宿主机时区不影响容器。

**错过的那条会补发吗**
会，但只在 `GRACE_MINUTES`（默认 5 分钟）窗口内。超窗口不补，避免半夜收到过时提醒。

**端口冲突**
改 `docker-compose.yml` 里的 `8787:8787` 左侧端口，或本地运行时设 `PORT`。

**alpine 镜像里 `node:sqlite` 报错**
极少数情况下官方 alpine 构建缺少内置 sqlite，把 `Dockerfile` 首行改成 `FROM node:22-slim` 即可。

**忘记管理口令**
停服务后删掉 `data/app.db` 里的设置表即可（会一并丢掉其他配置）：
`sqlite3 data/app.db "DELETE FROM settings WHERE k='admin_token';"`，或直接清空数据重录。

**镜像拉下来跑不起来，报 `exec format error`**
架构不匹配。在 arm64 机器（如 Apple Silicon Mac）上构建的单架构镜像，无法在 x86_64 设备上运行。
本项目的 CI 已构建 `linux/amd64` + `linux/arm64` 双架构；若自己手动构建，请用：

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t pill-reminder:latest .
```

或者直接在目标设备上用 `docker compose up -d --build` 本地构建，天然匹配本机架构。

**GHCR 拉取超时**
国内访问 `ghcr.io` 不稳定属于常态，不是仓库问题。改用方式一本地构建即可；
也可以把镜像同步到阿里云 ACR 等国内仓库再拉。

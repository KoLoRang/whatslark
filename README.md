# WhatsLark · WhatsApp ↔ 飞书 群消息双向同步

把一个 WhatsApp 账号里的**每个群聊**自动在飞书建一个对应群，**所有私聊**归集到一个飞书话题群（每个联系人一个话题），消息**双向实时同步**：

- WhatsApp 群/私聊新消息 → 飞书（自动建群/建话题）
- 我在飞书里的回复 → 以**我本人 WA 账号**名义发回对应 WhatsApp 群/私聊
- 支持 **文本 + 图片 + 文件 + 语音**；支持 WA 群改名同步；登录后一次性全量建群 + 历史消息归集

---

## 技术栈

Node.js 20+ / TypeScript · [Baileys](https://baileys.wiki)（WhatsApp）· [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)（飞书 Client + 长连接 WSClient）· SQLite（better-sqlite3）· Docker。

## 目录结构

```
src/
  index.ts            入口：initDb → App → Monitor
  config.ts           环境变量配置
  logger.ts           pino 分模块日志
  types.ts            共享类型
  db.ts               SQLite 数据层（建表/映射/去重/配置）
  app.ts              协调层：按配置装配 WA/飞书/路由，配置热加载
  monitor.ts          配置文件监听 + 命令文件 + 状态文件（替代 Web 配置页）
  whatsapp/
    auth-sqlite.ts    SQLite 版 Baileys authState（替代 useMultiFileAuthState）
    socket.ts         WA socket：连接/重连/终端QR/消息监听/群信息/媒体
  feishu/
    client.ts         Lark Client：建群/建话题群/发文本/话题回复/媒体/改名
    ws.ts             WSClient 长连接：订阅 im.message.receive_v1
  bridge/
    router.ts         双向路由核心：建群/话题归集/去重/防回环
    mutex.ts          按键串行锁，防并发重复建群
bin/
  whatslark.sh        CLI 命令脚本（status / feishu-config / wa-login / mappings 等）
```

---

## 本地运行

```bash
npm install
npm run build      # 编译 TS → dist/
npm start          # 启动（DB ./data/bridge.db，配置 ./data/config.json）
# 或开发模式
npm run dev
```

---

## 配置方式（配置文件 + CLI 脚本，无 Web 页面）

本项目通过 **挂载的配置文件** + **docker exec CLI 命令** 管理配置，不再有 Web 配置页。

### 飞书配置：编辑 `./data/config.json`

首次启动会自动生成空模板，填入飞书应用信息即可：

```json
{
  "app_id": "cli_xxx",
  "app_secret": "你的应用密钥",
  "my_open_id": "ou_xxx",
  "bot_open_id": ""
}
```

- 修改后**自动热加载**（无需重启容器），飞书 Client + WSClient 自动重建。
- 也可用 CLI 一键设置：`docker exec whatslark whatslark feishu-set cli_xxx mysecret ou_yyy`
- ⚠️ **`my_open_id` 非常重要**：自动建的飞书群会把这个用户拉进去。**不填你就不会被拉进群、收不到任何消息**。它是你在该飞书应用下的 open_id（可在飞书开放平台调试台或事件回调里拿到）。用 `feishu-set` 省略第三个参数时会**保留原值**，不会清空。

### WhatsApp 登录：终端 QR

```bash
# 触发登录，QR 会打印到容器日志
docker exec whatslark whatslark wa-login

# 跟踪日志查看 QR 码，用手机 WhatsApp 扫码
docker compose logs -f whatslark
```

手机端路径：**WhatsApp → 设置 → 已关联的设备 → 关联新设备 → 扫描日志里的二维码**。

- 二维码每约 20 秒**自动刷新**，过期会自动重出；扫码成功后日志显示「✅ WhatsApp 已连接」。
- 已登录时再次执行 `wa-login` **不会重复弹码**（日志提示「已处于登录状态」）。
- 登录态存于 SQLite（`/data` 挂载），容器重建后**自动重连**，无需重新扫码。

### CLI 命令一览（`docker exec whatslark whatslark <cmd>`）

| 命令 | 说明 |
|---|---|
| `whatslark status` | 查看服务状态（飞书配置、WA 连接、映射数量） |
| `whatslark feishu-config` | 查看当前配置 |
| `whatslark feishu-set <id> <secret> [open_id]` | 设置飞书配置（自动热加载） |
| `whatslark wa-login` | 触发 WhatsApp 登录（QR 打印到日志） |
| `whatslark wa-logout` | WhatsApp 登出 |
| `whatslark mappings` | 查看消息映射表（群 + 私聊话题） |
| `whatslark help` | 显示帮助 |

### 飞书侧一次性准备（开发者后台）

- 创建**企业自建应用**，开启**机器人**能力。
- 开通权限 scope：`im:chat:create`、`im:chat:update`、`im:message`、`im:message:send_as_bot`、`im:resource`、`im:chat.members:write_only`，并**发布版本**。
- 「事件与回调」订阅 `im.message.receive_v1`，订阅方式选**长连接**（需先把本服务跑起来，长连接建立后再保存）。

---

## Docker 部署

### 首次部署步骤

```bash
# 1. 克隆仓库
git clone <repo-url> && cd whatslark

# 2. 构建并启动
docker compose up -d --build

# 3. 配置飞书（编辑配置文件或用 CLI）
#    方式 A：编辑 ./data/config.json 填入飞书信息（自动热加载）
#    方式 B：docker exec whatslark whatslark feishu-set cli_xxx mysecret ou_yyy

# 4. 登录 WhatsApp
docker exec whatslark whatslark wa-login
docker compose logs -f whatslark   # 扫描终端 QR

# 5. 验证状态
docker exec whatslark whatslark status
```

### 数据持久化

- 所有状态存于 `/data/` 目录（SQLite、WA 凭证、config.json、status.json），通过 `./data:/data` **挂载到宿主机**，容器重建数据不丢。
- 飞书长连接为**出站**连接，无需任何入站端口映射。

### 数据备份

```bash
# 停止容器后直接复制数据目录
docker compose stop
cp -r ./data ./data-backup-$(date +%Y%m%d)
docker compose start
```

### 升级流程

```bash
# 拉取最新代码
git pull origin main

# 重建镜像并启动（数据在宿主机 ./data 不受影响）
docker compose up -d --build

# 查看日志确认启动正常
docker compose logs -f --tail 50
```

### 主要环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DB_PATH` | `./data/bridge.db` | SQLite 文件路径 |
| `SYNC_ALL_GROUPS` | `true` | 登录后全量建群（A3） |
| `SYNC_FULL_HISTORY` | `true` | 拉取历史消息（A2） |
| `SEND_INTERVAL_MS` / `HISTORY_INTERVAL_MS` / `GROUP_SYNC_INTERVAL_MS` | 600 / 400 / 1500 | 限速防风控 |
| `DEDUP_RETENTION_DAYS` | `7` | 去重记录保留天数 |
| `MAX_MEDIA_BYTES` | `52428800` | 媒体最大字节数，超出降级文本 |

> 完整环境变量见 [`CLAUDE.md`](CLAUDE.md) 与 [`config.ts`](src/config.ts)。

---

## 已知限制与风险

- **WhatsApp 封号风险**：Baileys 非官方库，自动化个人账号有概率被封；请用可接受被封的账号、控制频率、勿群发滥用。
- **历史消息有限**：多设备协议下 WA 只回传有限的近期历史，并非全部聊天记录。
- **单实例**：飞书长连接不广播 + SQLite 单写入者 → 单实例部署（无高可用需求）。
- **媒体范围**：支持文本/图片/文件/语音（语音通过 ffmpeg 转码为 opus/ogg）；贴纸、位置、名片等降级为文本提示。飞书侧富文本回复（post：@人、加粗、链接）会自动解析为纯文本回传 WhatsApp。
- **凭证安全**：`app_secret` 与 WA 登录凭证均**明文存于 SQLite**（`/data/bridge.db`），无 Web 端口、无入站连接，安全性完全依赖 `/data` 目录的**文件权限**——请妥善保护宿主机该目录，勿将 `./data` 提交到仓库或公开分享（`feishu-config` 输出已对 `app_secret` 脱敏，避免截图泄密）。

## License

MIT

# 跨设备会话互联 — 改造计划

生成时间:2026-11-25
目标:两台电脑的 DSH 插件通过 dsh-bridge 互联,侧边栏按设备分组展示所有会话,点击可实时拉取并同步。

## 一、勘察结论(现有可复用资产)

### dsh-bridge 服务端(保留,增量扩展)
- 零依赖 Node ESM,仅用 `node:` 内置模块(Node >= 22.5)
- 现有 `/v1/*` 接口 + JSON 存储(`hub-store.json`)+ 长轮询 + SSE
- 已有 Bearer 鉴权(`safeEqual` 常量时间比较)、错误映射、CORS
- **决策:不动 `/v1/*`,新增 `/api/v1/*` 并行存在**,老 Mac CLI 继续可用

### DSH 插件契约(已确认)
- 服务端半:`lib/index.js` → `export const inject = ['webServer']` + `apply(ctx)`
  - 路由:`ctx.webServer.register({ kind, path, handler(req,res) })`
  - WS 升级:`ctx.webServer.registerUpgrade({ path, handler(req, socket, head) })`
  - 生命周期:`ctx.effect(() => dispose, 'label')`;`ctx.webServer.port/.host`
- 客户端半:`lib/client.js` → `window.__ModuleLoader__.load({ id, factory(require) })`
  - 直接 `require('react')`,**无构建、不能写 JSX**(用 `h = createElement`)
  - 插槽:`ctx.slots.inject(name, () => ctx.slots.register({ name, id, order, label, locale, inject }, Component))`
  - 侧边栏可用插槽:`sidebar.workspaces`(浏览会话区)、`sidebar.panellist`、`sidebar.footer.action` 等
- 包声明:`package.json` 的 `dsh.client = { platform: 'web', immediately: true, inject: [...] }`

### 会话文件格式(已确认)
- 路径:`~/.dsh/sessions/<编码工作区>/session-<id>/session.v4.jsonl.zstd`
- 首行 `{"type":"session", id, createdAt, cwd, ...}`,其后为事件(带 `seq`/`time`/`data`)
- 消息事件:
  - `user/message`:`data.id`(UUID)、`data.role`、`data.content[{type:"text",text}]`
  - `assistant/message`:`data.message.{role,content[]}`,**无自带 id** → 用 `(sessionId, seq)` 生成确定性 UUID 保证幂等
  - `session/title`:`data.title`
  - `system/message`:系统提示词(数万字符)→ **默认跳过**,避免把提示词当消息推送

## 二、服务端改造

### 新增文件(不动已有文件的结构)
```
server/src/db.js        SQLite 三表 + 查询(node:sqlite DatabaseSync,零依赖)
server/src/ws.js        RFC6455 手写 WS 服务端(握手/帧/掩码/ping-pong/广播)
server/src/api-v1.js    /api/v1/* 路由处理
```
`app.js` / `index.js` 仅增加挂载点(路由分派 + upgrade 转发)。

### 表结构(严格按需求)
- `devices(device_id PK, device_name, platform, last_seen_at, status)`
- `sessions(session_id PK, device_id FK, title, latest_seq, updated_at)`
- `messages(seq INTEGER 自增, msg_id UNIQUE, session_id, device_id, role, content, created_at)`
- 索引:`messages(session_id, seq)`、`sessions(device_id, updated_at)`
- 在线判定:`last_seen_at` 距今 > 60s 视为 offline(查询时计算,不落盘)

### 接口(全部 Bearer 鉴权)
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/v1/devices/heartbeat | 上报 device_id/name/platform,刷新 last_seen_at |
| POST | /api/v1/sessions/sync | 批量 upsert 会话元数据 |
| POST | /api/v1/sessions/{id}/messages | 增量推消息,msg_id 幂等,分配 seq,更新 latest_seq/updated_at,WS 广播 |
| GET | /api/v1/sidebar | 设备列表 + 各自按 updated_at 倒序的会话 |
| GET | /api/v1/sessions/{id}/messages?since_seq&limit | 增量拉取 |
| WS | /api/v1/ws?device_id=... | 事件推送 + 30s ping/pong |

WS 事件:`device_updated` / `session_updated` / `new_message`(轻量,只带 id 与 seq)
保活:服务端每 30s 发 ping 帧;客户端回 pong;同时容忍 Cloudflare 100s 空闲断连。

## 三、插件端改造(新建 dsh-cross-device 插件)

```
dsh-cross-device/
  package.json          dsh.bundle.patch + dsh.client
  cordis.patch.yml      insert 自身
  lib/index.js          服务端半:心跳/扫描/推送/重试队列/配置读写/暴露 /api/cross-device/config
  lib/client.js         客户端半:侧边栏插槽 + 设备分组 + 会话查看器 + WS
  lib/scan.js           会话文件解析(zstd 解压 + JSONL → 会话/消息)
  lib/hub-client.js   Hub REST 调用 + 重试
```

- **配置**:`~/.dsh/cross-device/config.json`(0600);首次启动生成 `device_id`(UUID)与 `device_name`(主机名)
- **Publisher**:25s 心跳;本地会话变化 → 增量推送;失败进重试队列(指数退避);`msg_id` 幂等
- **Sidebar**:注册到 `sidebar.workspaces`,按 `device_name` 分组,标注在线/离线/(本机)
- **Viewer**:点击会话 → 先渲染本地缓存 → `since_seq` 增量拉取 → WS 实时追加;WS 断开时 3s 轮询并自动重连

## 四、实施顺序
1. 服务端 `db.js`(建表 + 查询)
2. 服务端 `ws.js`(握手 + 帧 + 心跳 + 广播)
3. 服务端 `api-v1.js` + 挂载
4. 服务端测试(node:test,覆盖幂等/离线判定/增量拉取)
5. 插件 `scan.js` + `hub-client.js`
6. 插件 `lib/index.js`(心跳/推送/重试)
7. 插件 `lib/client.js`(侧边栏/查看器/WS)
8. 双实例联调 + 三项验收

## 五、验收
1. A 建会话发消息 → B 侧边栏出现 A 与该会话
2. B 点击可完整拉历史,且 A 继续发消息时 B 实时刷新
3. 断网/重启后按 `since_seq` + `msg_id` 补齐,无重复

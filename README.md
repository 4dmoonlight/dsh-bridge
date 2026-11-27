# dsh-bridge

给 DeepSeek Harness（DSH）做的**会话同步中转**：Mac 上读取本地会话，推给一台你自己控制的中转服务器；其他设备（或另一台 Mac）从中转读，或让它实时向 Mac 要最新版本。

原生客户端仍只同步会话，不同步终端、文件、模型配置或聊天。DSH 的「跨设备」插件另可列出已配对设备，在新标签页打开远端实际运行的 DSH Web。

```
Mac (dsh-bridge)  ──push──►  中转服务器 (hub)  ◄──list/read──  其他客户端
       ▲                          │
       └──── long-poll 取指令 ─────┘   在线时实时取最新会话，离线时读已存快照
```

## 为什么是这种形态

参考了两个成熟实现，但只取最小可用的一刀：

- [ds-harness-remote](https://github.com/liguobao/ds-harness-remote)：WebSocket 控制面 + 盲转发 + Noise 端到端加密，服务端**从不存会话内容**；功能全，但体量大。
- [dsh-mobile-plugin](https://github.com/WNUO/dsh-mobile-plugin)：手机端插件，宿主主动外拨 WSS 隧道，帧编码 + 二维码配对。

本项目保留它们的核心形态（**宿主主动外拨、设备身份随请求携带、服务端单调 revision、live/stored 明确区分**），但换成零依赖 HTTP + long-poll，并把“会话快照”真正落盘，因此：

- Mac 不需要公网 IP、不需要开入站端口、不需要证书；
- 客户端在 Mac 睡眠时也能读到上一次的快照；
- 约 2.2k 行实现（服务端 900 行、Mac 端 1.3k 行），没有构建链（服务端零依赖，Mac 端一个 SwiftPM 包）。

代价是服务端持有**明文会话**、单租户、无端到端加密——见 [docs/SECURITY.md](docs/SECURITY.md)。

## 快速开始

要求：macOS 13+、Node ≥ 22.5、Xcode 命令行工具、`zstd`（`brew install zstd`）。

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge
./install.sh all
```

安装脚本会：生成中转令牌 → 起中转（LaunchAgent，默认 8787）→ 编译并安装 `dsh-bridge` 到 `~/.local/bin` → 注册本机 → 起宿主循环（LaunchAgent）。

验证：

```bash
~/.local/bin/dsh-bridge doctor
~/.local/bin/dsh-bridge push --limit 50
~/.local/bin/dsh-bridge list
```

想看界面：`~/.local/bin/dsh-bridge ui`。

## 在浏览器打开远端 DSH

更新 Hub 和两台电脑的插件后，在「跨设备」用同一个 Google 账号登录。在被控电脑开启「允许远程控制本机」后，就能从另一台一键打开实际运行的 DSH Web。开关默认关闭，不需要分别配置 HTTPS 地址或 Web 配对码，不镜像屏幕。见 [Google 登录和远端 Web 配置](docs/WEB-ACCESS.md)。

Hub 还可选配独立网页入口：手机或没有 DSH 插件的电脑也能通过 Google 账号选设备。目标机需另外开启服务器网页访问；该模式下服务器可以读取 DSH 网页内容。见 [浏览器入口说明](docs/WEB-ACCESS.md#browser-only-entry-optional)。

## 命令

| 命令 | 作用 |
| --- | --- |
| `dsh-bridge register --hub URL --token T` | 注册本机，保存设备令牌 |
| `dsh-bridge push [--limit N] [--full]` | 读取 `~/.dsh/sessions` 并推送 |
| `dsh-bridge serve` | 宿主模式：定时推送 + 保持 long-poll 应答实时请求 |
| `dsh-bridge list [--query Q]` | 列出中转上的会话 |
| `dsh-bridge show <id>` | 打印一条会话的完整内容 |
| `dsh-bridge ui` | 打开 SwiftUI 窗口 |
| `dsh-bridge doctor` | 自检：会话目录、zstd、配置、中转健康 |
| `dsh-bridge config` | 显示配置（令牌打码） |

## 中转服务

零依赖，直接跑：

```bash
BRIDGE_PORT=8787 BRIDGE_DATA_DIR=~/.dsh-bridge/hub-data \
  node apps/server/src/index.js
```

远程部署请务必放在 TLS 反代后面（Caddy/nginx/Cloudflare Tunnel），见 [docs/INSTALL.md](docs/INSTALL.md)。

## 一起看

- 协议：[docs/PROTOCOL.md](docs/PROTOCOL.md)（`bridge/1`，全部端点与错误码）
- 架构与取舍：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 安装与排障：[docs/INSTALL.md](docs/INSTALL.md)
- 安全边界：[docs/SECURITY.md](docs/SECURITY.md)
- 给 agent 的安装/验证手册：[AGENTS.md](AGENTS.md)

## 测试

```bash
(cd apps/server && npm test)   # Hub 鉴权、配对、同步与转发
node --test packages/dsh-cross-device/test/*.test.js  # 设备面板
(cd apps/macos && swift test)  # 模型、配置、DSH v4 解析
bash scripts/e2e.sh           # 原生客户端的 live 与 stored 路径
node scripts/e2e-web.mjs           # 需 dsh CLI；本地双实例、模拟 Google 和中转
node scripts/e2e-web.mjs --portal  # 独立网页、原生 WebSocket 和撤权
```

## 已知边界

- 老会话同步不传终端、文件、附件或模型配置。远程 DSH Web 可以使用 DSH 本身开放的能力，网页流量通过 Hub 加密转发。
- 会话同步是单租户：合法的会话同步令牌可读全部会话；Web 设备令牌不能读取这些会话。
- 会话同步快照不加密，服务端存明文（有上限：每会话 2000 条消息 / 单条 2 万字符）。
- 单进程存储（JSON 原子替换）；不要多实例共享同一目录。
- macOS 宿主和 iOS 客户端继续使用会话同步协议；Web 配对是单独的授权。

## License

MIT

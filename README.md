# dsh-relay-sync

给 DeepSeek Harness（DSH）做的**会话同步中转**：Mac 上读取本地会话，推给一台你自己控制的中转服务器；其他设备（或另一台 Mac）从中转读，或让它实时向 Mac 要最新版本。

首个版本（macOS）**只做会话同步**——不同步终端、文件、模型配置，也不做聊天转发。

```
Mac (relay-sync)  ──push──►  中转服务器 (relay)  ◄──list/read──  其他客户端
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
git clone https://github.com/OWNER/dsh-relay-sync.git
cd dsh-relay-sync
./install.sh all
```

安装脚本会：生成中转令牌 → 起中转（LaunchAgent，默认 8787）→ 编译并安装 `relay-sync` 到 `~/.local/bin` → 注册本机 → 起宿主循环（LaunchAgent）。

验证：

```bash
~/.local/bin/relay-sync doctor
~/.local/bin/relay-sync push --limit 50
~/.local/bin/relay-sync list
```

想看界面：`~/.local/bin/relay-sync ui`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `relay-sync register --relay URL --token T` | 注册本机，保存设备令牌 |
| `relay-sync push [--limit N] [--full]` | 读取 `~/.dsh/sessions` 并推送 |
| `relay-sync serve` | 宿主模式：定时推送 + 保持 long-poll 应答实时请求 |
| `relay-sync list [--query Q]` | 列出中转上的会话 |
| `relay-sync show <id>` | 打印一条会话的完整内容 |
| `relay-sync ui` | 打开 SwiftUI 窗口 |
| `relay-sync doctor` | 自检：会话目录、zstd、配置、中转健康 |
| `relay-sync config` | 显示配置（令牌打码） |

## 中转服务

零依赖，直接跑：

```bash
RELAY_TOKEN=secret RELAY_PORT=8787 RELAY_DATA_DIR=~/.dsh-relay-sync/relay-data \
  node server/src/index.js
```

远程部署请务必放在 TLS 反代后面（Caddy/nginx/Cloudflare Tunnel），见 [docs/INSTALL.md](docs/INSTALL.md)。

## 一起看

- 协议：[docs/PROTOCOL.md](docs/PROTOCOL.md)（`relay/1`，全部端点与错误码）
- 架构与取舍：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 安装与排障：[docs/INSTALL.md](docs/INSTALL.md)
- 安全边界：[docs/SECURITY.md](docs/SECURITY.md)
- 给 agent 的安装/验证手册：[AGENTS.md](AGENTS.md)

## 测试

```bash
cd server && npm test          # 12 个用例：鉴权、同步、跳过旧快照、重启持久化、实时中转、SSE
cd apps/macos && swift test    # 模型、配置、DSH v4 解析
bash scripts/e2e.sh            # 起真中转 + 真二进制，验证 live 与 stored 两条路径
```

## 已知边界

- 只同步会话：不传终端、文件、附件、模型配置。
- 单租户：所有合法令牌可读全部会话。
- 无端到端加密；服务端存明文快照（有上限：每会话 2000 条消息 / 单条 2 万字符）。
- 单进程存储（JSON 原子替换）；不要多实例共享同一目录。
- 仅 macOS 宿主；iOS/网页客户端尚未实现（协议已就绪）。

## License

MIT

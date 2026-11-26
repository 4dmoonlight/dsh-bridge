# dsh-cross-device

在 **DeepSeek Harness** 的「跨设备」只列出直接配对的远端设备。点击在线设备，在新标签页打开它实际运行的 DSH Web（插件、侧栏、工作区和会话）。不镜像屏幕，不在本机重画会话界面。

配套服务端:[dsh-bridge](https://github.com/4dmoonlight/dsh-bridge)。

## 安装

```bash
git clone https://github.com/4dmoonlight/dsh-bridge.git
cd dsh-bridge/packages/dsh-cross-device
./scripts/install.sh
```

默认装进 `~/.dsh/profiles/web`。装到别的 profile:

```bash
DSH_PROFILE=~/.dsh/profiles/desktop ./scripts/install.sh
```

需要带 `--public-url` 和 `--trusted-host` 支持的 DSH Web（已用 0.2.2-rc.5 验证）。**重启 DSH 生效**，侧边栏会出现 `⇄` 图标。

## 配置

打开插件配置(或直接改 `~/.dsh/cross-device/config.json`,权限 0600):

```json
{
  "hub_url": "https://hub.example.com",
  "hub_token": "<hub 的实例 token>",
  "device_id": "<首次启动自动生成的 UUID>",
  "device_name": "<默认取主机名,可改>",
  "enabled": true
}
```

以上是原有会话同步配置；不要把实例令牌分发给其他设备。启用 Google 登录只需在 Hub 配一次 OAuth，之后两台机器在「跨设备」用同一个 Google 账号登录即可，无需实例令牌和邀请码。也可退回 Web 邀请码；旧的六位会话同步码（含 iOS）继续可用，但不授予 Web 入口。

### 打开原版 DSH Web

1. 更新 Hub 和两边的插件。在「跨设备」用同一个 Google 账号登录，或使用 Web 邀请码配对。
2. 在远端配置可达的私有 HTTPS 入口，启动 DSH Web 时通过 `--public-url` 和 `--trusted-host` 公告该入口。只接受独立 HTTPS 根地址，不填带 `?token=` 的启动链接；远端 DSH 仍可保持回环监听。
3. 在远端插件启用该地址。查看端浏览器首次先登录此 HTTPS 地址上的 DSH；随后点已配对的在线设备即可进入原版页面。

Hub 不代理网页、不代登录。解绑只撤销插件入口，不会使已经登录的 DSH 自动退出。详见 [Web 接入说明](../../docs/WEB-ACCESS.md)。

## 卸载

```bash
./scripts/install.sh --uninstall
```

## 工作方式

- 每 25 秒心跳,每 15 秒按文件 mtime 增量扫描 `~/.dsh/sessions`
- 新消息增量推送到 hub,按 `msg_id` 幂等去重
- 推送水位按 hub 地址隔离:换 hub 会重新全量推送
- 设备状态每 25 秒向 Hub 更新；Web 专属设备令牌独立于会话同步，只留在插件后端
- 插件 API 使用 DSH 的同源与所有者登录检查；更换会话同步 `hub_url` 必须重新提供 token

## 安全说明

hub 侧存的是**明文会话内容**,token 等同密码,可读全部会话。请只在自建 hub 上使用。

## 自检

```bash
node --check lib/scan.js
node scripts/selftest-scan.js   # 用本机真实会话文件验证解析
```

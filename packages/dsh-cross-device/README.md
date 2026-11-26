# dsh-cross-device

在 **DeepSeek Harness** 的「跨设备」可找到登录同一 Google 账号的设备。点击在线且允许远程控制的设备，在新标签页打开它实际运行的 DSH Web（插件、侧栏、工作区和会话）。不镜像屏幕，不在本机重画会话界面。

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

需要支持 Web 的 DSH（已用 0.2.2-rc.5 验证）；使用默认回环监听即可。**重启 DSH 生效**，侧边栏会出现 `⇄` 图标。

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

以上是原有会话同步配置；不要把实例令牌分发给其他设备。启用 Google 登录只需在 Hub 配一次 OAuth，之后两台机器在「跨设备」用同一个 Google 账号登录即可，无需实例令牌和邀请码。新面板不显示任何配对码。旧的会话同步接口（含 iOS）仍保留兼容，不授予远程打开权限。

### 打开原版 DSH Web

1. 更新 Hub 和两边的插件。在「跨设备」用同一个 Google 账号登录。
2. 在被控电脑的本机 DSH 页面打开「允许远程控制本机」（默认关闭）。
3. 另一台电脑点「打开 Web」即可。不必配置被控机的 HTTPS 地址或入站端口。

关闭开关会断开中转访问。受控范围是目标 DSH Web，不是屏幕共享。详见 [Web 接入说明](../../docs/WEB-ACCESS.md)。

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

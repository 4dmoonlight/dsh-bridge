# dsh-cross-device

让多台电脑上的 **DeepSeek Harness** 通过一个 relay 互联:侧边栏按电脑分组展示所有会话,
点开任意会话即可拉取内容,对方继续发消息时自动增量刷新。

配套服务端:[dsh-relay-sync](https://github.com/4dmoonlight/dsh-relay-sync)。

## 安装

```bash
git clone https://github.com/4dmoonlight/dsh-relay-sync.git
cd dsh-relay-sync/packages/dsh-cross-device
./scripts/install.sh
```

默认装进 `~/.dsh/profiles/web`。装到别的 profile:

```bash
DSH_PROFILE=~/.dsh/profiles/desktop ./scripts/install.sh
```

**重启 DSH 生效**,侧边栏会出现 `⇄` 图标。

## 配置

打开插件配置(或直接改 `~/.dsh/cross-device/config.json`,权限 0600):

```json
{
  "relay_url": "https://relay.example.com",
  "relay_token": "<relay 的实例 token>",
  "device_id": "<首次启动自动生成的 UUID>",
  "device_name": "<默认取主机名,可改>",
  "enabled": true
}
```

多台电脑填**同一个** `relay_url` 和 `relay_token` 即可互联;每台会自动生成自己的 `device_id`。

## 卸载

```bash
./scripts/install.sh --uninstall
```

## 工作方式

- 每 25 秒心跳,每 15 秒按文件 mtime 增量扫描 `~/.dsh/sessions`
- 新消息增量推送到 relay,按 `msg_id` 幂等去重
- 推送水位按 relay 地址隔离:换 relay 会重新全量推送
- 实时更新走 3 秒增量轮询,**relay token 始终留在 Node 进程内**,不进浏览器
- 本机接口有同源检查与自定义头校验;更换 `relay_url` 必须重新提供 token,
  避免旧凭据被发往新地址

## 安全说明

relay 侧存的是**明文会话内容**,token 等同密码,可读全部会话。请只在自建 relay 上使用。

## 自检

```bash
node --check lib/scan.js
node scripts/selftest-scan.js   # 用本机真实会话文件验证解析
```

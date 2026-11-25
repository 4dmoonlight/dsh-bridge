# RelaySync for iOS

跨设备会话查看器:和 `packages/dsh-cross-device` 插件功能对齐——用一次性配对码接入,
按设备分组浏览会话,点开即可读消息并每 3 秒增量刷新。

## 构建

需要 Xcode 27+(iOS 17.0 以上)与 [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
brew install xcodegen
cd apps/ios && xcodegen generate
open RelaySync.xcodeproj
```

命令行构建模拟器版本:

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
xcodebuild -project RelaySync.xcodeproj -scheme RelaySync \
  -sdk iphonesimulator -destination "generic/platform=iOS Simulator" build
```

装到真机需要在 Xcode 里选自己的 Team 签名(本项目 `CODE_SIGNING_ALLOWED: NO`,
仅为模拟器构建免签名)。

## 使用

1. 首发启动进入「连接中继」页
2. 填中继地址(和电脑上同一个)与配对码
3. 配对码在已连接的电脑上点「添加设备」获取,10 分钟有效、单次使用

token 存 Keychain,不需要手动抄写。断开重配在右上角菜单里。

## 实现要点

- `RelayClient`:只调 `/api/v1` 的 `pairing/claim`、`sidebar`、`sessions/{id}/messages`,以及 `devices/heartbeat`
- `Store`:设备列表 5 秒轮询;打开会话后 3 秒增量轮询(`since_seq`),按 `msg_id` 去重
- `device_id` 用 `identifierForVendor`,重装后不变,不会在别人的侧边栏留下离线幽灵设备
- DEBUG 构建支持 `-relayURL`/`-pairCode`/`-autoOpen` 启动参数,便于自动化验证

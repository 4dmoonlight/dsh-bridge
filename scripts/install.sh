#!/usr/bin/env bash
# dsh-cross-device 一键安装:把插件放进 DSH profile 并在补丁层挂载。
#
#   ./scripts/install.sh                  # 装进 ~/.dsh/profiles/web
#   DSH_PROFILE=~/.dsh/profiles/desktop ./scripts/install.sh
#
# 卸载:见 --uninstall
set -euo pipefail

PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/web}"
PKG_NAME="dsh-cross-device"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCH="$PROFILE/cordis.patch.yml"
DEST="$PROFILE/node_modules/$PKG_NAME"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$DEST"
  if [ -f "$PATCH" ]; then
    cp "$PATCH" "$PATCH.bak-uninstall-$STAMP"
    python3 - "$PATCH" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = re.sub(r"\n# 跨设备会话互联插件[^\n]*\n- insert:\n    - id: dsh-cross-device\n      name: 'dsh-cross-device'\n", "\n", s)
open(p, 'w', encoding='utf-8').write(s)
PY
  fi
  echo "已卸载。重启 DSH 生效。"
  exit 0
fi

[ -d "$PROFILE" ] || { echo "找不到 profile:$PROFILE" >&2; exit 1; }
[ -f "$PATCH" ] || { echo "找不到 $PATCH" >&2; exit 1; }

echo "== 安装到 $PROFILE"
mkdir -p "$PROFILE/node_modules"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
rm -rf "$DEST/.git" "$DEST/scripts"

if grep -q "dsh-cross-device" "$PATCH"; then
  echo "== 补丁层已存在挂载行,跳过"
else
  cp "$PATCH" "$PATCH.bak-cross-device-$STAMP"
  printf "\n# 跨设备会话互联插件\n- insert:\n    - id: dsh-cross-device\n      name: 'dsh-cross-device'\n" >> "$PATCH"
  echo "== 已写入挂载行(备份:$PATCH.bak-cross-device-$STAMP)"
fi

echo
echo "完成。重启 DSH 后:"
echo "  1. 刷新页面,侧边栏出现 ⇄ 图标"
echo "  2. 打开插件配置,填 relay_url 与 relay_token"
echo
echo "回滚:"
echo "  rm -rf $DEST"
echo "  cp $PATCH.bak-cross-device-$STAMP $PATCH"

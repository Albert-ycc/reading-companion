#!/bin/bash
# 安装伴读后台服务：登录即启动，挂了自动拉起。卸载：./install.sh --uninstall
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.albert.reading-companion
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"
  echo "已卸载伴读后台服务"
  exit 0
fi

# 扫描页识别工具（macOS Vision）：源码比二进制新就重新编译
if [[ ! -x "$DIR/bin/ocr" || "$DIR/tools/ocr.swift" -nt "$DIR/bin/ocr" ]]; then
  mkdir -p "$DIR/bin"
  swiftc -O "$DIR/tools/ocr.swift" -o "$DIR/bin/ocr"
fi

CLAUDE_BIN="$(PATH="$HOME/.local/bin:$PATH" command -v claude)"
mkdir -p "$DIR/data" "$HOME/Library/LaunchAgents"
sed -e "s#__DIR__#$DIR#g" -e "s#__CLAUDE_BIN__#$CLAUDE_BIN#g" -e "s#__HOME__#$HOME#g" \
  "$DIR/launchd/$LABEL.plist" > "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
sleep 1
curl -sf http://127.0.0.1:8770/api/ping > /dev/null && echo "伴读后台服务已启动：http://127.0.0.1:8770/"

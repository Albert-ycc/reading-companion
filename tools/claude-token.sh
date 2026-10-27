#!/bin/bash
# 存后台调 claude 用的长期令牌。先在终端跑 `claude setup-token`，把它打印的 sk-ant- 开头那一串粘到这里。
# 存进 data/claude-oauth-token（权限 600），服务每次调 claude 时现读，不用重启；删掉这个文件就回到用命令行登录。
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${READER_DATA:-$PWD/data}"

echo "粘贴 claude setup-token 打印的令牌，再按一次回车结束（输入不回显，终端里折成两行也没关系）："
# setup-token 的界面会把令牌硬折成两行，只读一行会存成半截：读到空行为止再拼起来
raw=""
while IFS= read -rs line || [ -n "$line" ]; do  # 最后一行没有换行就结束输入时，read 返回失败但 line 有内容
  [ -n "$line" ] || break
  raw+="$line"
done
echo
# 折行处带换行和缩进空格，粘贴还可能在两头带不可见的控制符：去掉空白后只取 sk-ant- 开头的那一串
token=$(printf '%s' "$raw" | tr -d '[:space:]' | grep -oE 'sk-ant-[A-Za-z0-9_-]{20,}' | head -1 || true)
if [ -z "$token" ]; then
  echo "没认出令牌，没有保存：应该是 sk-ant- 开头的一整串"
  exit 1
fi

mkdir -p "$DATA"
umask 077
printf '%s\n' "$token" > "$DATA/claude-oauth-token"
chmod 600 "$DATA/claude-oauth-token"
echo "已保存到 $DATA/claude-oauth-token（权限 600），一年后到期，到期前重新生成一次再跑这个脚本"

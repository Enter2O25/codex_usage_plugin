#!/bin/zsh

# 查看后台进程和当前 Renderer 挂载状态，不修改 Codex 页面。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34

set -eu
source "$(dirname "$0")/common-macos.sh"

resolve_node
if injector_pid="$(read_injector_pid 2>/dev/null)"; then
  print -- "后台进程：运行中，PID=$injector_pid"
else
  print -- "后台进程：未运行"
fi

if cdp_is_ready; then
  "$NODE_BIN" "$CLI_PATH" status --port "$CDP_PORT" --json
else
  print -- '{"active":false,"reason":"CDP 端口未开启"}'
fi

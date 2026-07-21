#!/bin/zsh

# 停止后台服务并移除当前 Renderer 中的组件，不修改 Codex 安装包和皮肤。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34

set -eu
source "$(dirname "$0")/common-macos.sh"

resolve_node
if injector_pid="$(read_injector_pid 2>/dev/null)"; then
  /bin/kill -TERM "$injector_pid"
  deadline=$((SECONDS + 8))
  while injector_process_is_alive "$injector_pid" && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.2
  done
  injector_process_is_alive "$injector_pid" && fail "注入器未在超时内退出；未执行强制结束。"
fi
rm -f "$PID_FILE"

if cdp_is_ready; then
  "$NODE_BIN" "$CLI_PATH" remove --port "$CDP_PORT" --json
else
  print -- '{"removed":true,"removedCount":0,"reason":"Codex 当前没有开放 CDP 页面"}'
fi
print -- "Codex Usage Injector 已恢复，不影响现有 Codex 皮肤。"

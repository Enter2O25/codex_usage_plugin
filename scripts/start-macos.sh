#!/bin/zsh

# 启动 Codex Usage Injector；仅当调试端口不存在时才请求重启 Codex。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34

set -eu
source "$(dirname "$0")/common-macos.sh"

resolve_node
resolve_codex_bundle

if existing_pid="$(read_injector_pid 2>/dev/null)"; then
  # 更新重启期间端口可能短暂可访问，但页面列表已经为空；必须以 Codex page target 为准。
  if cdp_has_codex_page; then
    print -- "Codex Usage Injector 已在运行，PID=$existing_pid"
    "$NODE_BIN" "$CLI_PATH" status --port "$CDP_PORT" --json || true
    exit 0
  fi

  # Codex 重启后旧注入器可能仍在等待端口；此时不能直接退出，否则后续无法重新建立 CDP。
  # 修改人：liujl
  # 修改时间：2026-07-21 16:12:00
  # 修改说明：识别“注入器存在但 CDP 已消失”的重启场景，优雅停止旧实例后继续启动流程。
  print -- "检测到注入器正在等待 Codex 页面，先停止旧实例（PID=$existing_pid）"
  /bin/kill -TERM "$existing_pid"
  deadline=$((SECONDS + 8))
  while injector_process_is_alive "$existing_pid" && [ "$SECONDS" -lt "$deadline" ]; do
    /bin/sleep 0.2
  done
  injector_process_is_alive "$existing_pid" && fail "旧注入器未在超时内退出；未执行强制结束，请手动运行恢复命令。"
fi
rm -f "$PID_FILE"

if ! cdp_is_ready; then
  if codex_is_running; then
    # 重启会中断当前 Codex 任务，因此必须由桌面用户在系统对话框中明确确认。
    button="$(/usr/bin/osascript <<'APPLESCRIPT'
display dialog "为了启用本地注入，需要重新启动 Codex。当前任务会被中断，是否继续？" buttons {"取消", "重新启动"} default button "重新启动" cancel button "取消" with title "Codex Usage Injector"
button returned of result
APPLESCRIPT
)" || fail "用户取消了 Codex 重启。"
    [ "$button" = "重新启动" ] || fail "用户取消了 Codex 重启。"
    /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null
    deadline=$((SECONDS + 20))
    while codex_is_running && [ "$SECONDS" -lt "$deadline" ]; do
      /bin/sleep 0.25
    done
    codex_is_running && fail "Codex 未能正常退出；未执行强制结束，请手动关闭后重试。"
  fi

  /usr/bin/open -na "$CODEX_BUNDLE" --args \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CDP_PORT"
  wait_for_cdp || fail "Codex 已启动，但本地调试端口未就绪。"
fi

: > "$OUTPUT_LOG"
: > "$ERROR_LOG"
/usr/bin/nohup "$NODE_BIN" "$CLI_PATH" watch --port "$CDP_PORT" \
  >>"$OUTPUT_LOG" 2>>"$ERROR_LOG" &
injector_pid="$!"
print -- "$injector_pid" > "$PID_FILE"
/bin/sleep 1

injector_pid_is_valid "$injector_pid" || fail "注入器启动失败，请检查 $ERROR_LOG"
print -- "Codex Usage Injector 已启动，PID=$injector_pid"
print -- "诊断日志：$ERROR_LOG"
"$NODE_BIN" "$CLI_PATH" status --port "$CDP_PORT" --json || true

#!/bin/zsh

# Codex Usage Injector 的 macOS 启动公共逻辑。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34

set -eu

# 状态文件只允许当前用户访问，避免其他本机账户读取用量日志或伪造 PID。
umask 077

# 项目根目录由脚本自身位置解析，允许整个文件夹移动后继续使用。
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 默认 CDP 端口与 Codex Dream Skin 一致，两个注入器可共享同一 Renderer 端点。
CDP_PORT="${CODEX_USAGE_CDP_PORT:-9341}"
# 运行状态放在用户目录，不向 Codex 安装包或认证目录写入内容。
STATE_DIR="$HOME/.codex-usage-injector"
# PID 文件只记录本项目后台进程，停止时还会校验完整命令行防止误杀。
PID_FILE="$STATE_DIR/injector.pid"
# 常驻进程标准输出日志；JSON 命令结果通常写入这里。
OUTPUT_LOG="$STATE_DIR/injector.log"
# 常驻进程诊断日志；中文运行日志统一写入 stderr。
ERROR_LOG="$STATE_DIR/injector-error.log"
# Renderer 注入和数据轮询的 Node 入口。
CLI_PATH="$ROOT_DIR/src/cli.mjs"

mkdir -p "$STATE_DIR"

# 输出错误并终止脚本。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
fail() {
  print -u2 -- "[codex-usage] $1"
  exit 1
}

# 定位 Node.js 22+；全局 WebSocket 是 CDP 客户端的明确运行前提。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
resolve_node() {
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  [ -n "$NODE_BIN" ] || fail "未找到 Node.js，请先安装 Node.js 22 或更高版本。"
  local major
  major="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
  [ "$major" -ge 22 ] || fail "当前 Node.js 版本过低，需要 22 或更高版本。"
}

# 定位官方 Codex/ChatGPT 桌面应用，不接受同名非官方应用。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
resolve_codex_bundle() {
  CODEX_BUNDLE=""
  local candidate
  for candidate in "/Applications/ChatGPT.app" "$HOME/Applications/ChatGPT.app"; do
    if [ -d "$candidate" ] && [ "$(/usr/bin/mdls -raw -name kMDItemCFBundleIdentifier "$candidate" 2>/dev/null)" = "com.openai.codex" ]; then
      CODEX_BUNDLE="$candidate"
      break
    fi
  done
  [ -n "$CODEX_BUNDLE" ] || fail "未找到 Bundle ID 为 com.openai.codex 的官方 Codex 应用。"
}

# 探测本机调试端口是否已经可用；已启用换肤时可直接复用，不需要重启 Codex。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
cdp_is_ready() {
  /usr/bin/curl --max-time 1 -fsS "http://127.0.0.1:$CDP_PORT/json/list" >/dev/null 2>&1
}

# 判断 Codex 主应用是否正在运行。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
codex_is_running() {
  [ "$(/usr/bin/osascript -e 'application id "com.openai.codex" is running' 2>/dev/null || print false)" = "true" ]
}

# 校验 PID 对应进程确实是本项目 watch 命令，禁止仅凭陈旧 PID 发送信号。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
injector_pid_is_valid() {
  local pid="$1"
  [[ "$pid" == <-> ]] || return 1
  /bin/kill -0 "$pid" 2>/dev/null || return 1
  local command_line
  command_line="$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command_line" == *"$CLI_PATH"* ]] && [[ "$command_line" == *" watch"* ]]
}

# 返回仍在运行的本项目注入器 PID；无有效进程时返回失败。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
read_injector_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(tr -dc '0-9' < "$PID_FILE")"
  injector_pid_is_valid "$pid" || return 1
  print -- "$pid"
}

# 等待调试端口启动，超时表示当前 Codex 构建没有接受启动参数或应用启动失败。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34
wait_for_cdp() {
  local deadline=$((SECONDS + 25))
  while [ "$SECONDS" -lt "$deadline" ]; do
    cdp_is_ready && return 0
    /bin/sleep 0.25
  done
  return 1
}

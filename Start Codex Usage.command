#!/bin/zsh

# Finder 双击入口：启动用量注入器。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/scripts/start-macos.sh"

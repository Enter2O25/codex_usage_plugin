#!/bin/zsh

# Finder 双击入口：查看用量组件状态。
# 作者：liujl
# 创建时间：2026-07-21 13:47:34

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/scripts/status-macos.sh"

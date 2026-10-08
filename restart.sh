#!/usr/bin/env bash
# 重启服务；正在进行的采集会中断，已发布数据保留。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/deployment/service-control.sh" restart "$@"

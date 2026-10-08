#!/usr/bin/env bash
# 正常关闭服务及其采集子进程，保留数据和更新口令。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/deployment/service-control.sh" stop "$@"

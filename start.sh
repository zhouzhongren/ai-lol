#!/usr/bin/env bash
# 启动 kpl-insight 服务；首次未安装时自动调用 install.sh。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/deployment/service-control.sh" start "$@"

#!/usr/bin/env bash
# 首次安装依赖和 systemd 服务；完成后运行 start.sh。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/deployment/install-service.sh" "$@"

#!/usr/bin/env bash
# 启动已安装的 kpl-insight 服务；支持从任意目录调用。
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$SCRIPT_DIR/deployment/service-control.sh" start "$@"

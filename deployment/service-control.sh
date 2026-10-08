#!/usr/bin/env bash
# 三个入口共用 systemd，避免为同一服务引入另一套进程管理。
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT=kpl-insight.service
ACTION="${1:-}"
fail() { printf '%s\n' "$*" >&2; exit 1; }
logs_hint() { printf '查看日志：sudo journalctl -u %s -n 80 --no-pager\n' "$UNIT" >&2; }

if [[ $# != 1 || ! "$ACTION" =~ ^(start|restart|stop)$ ]]; then
    fail '用法：bash start.sh | bash restart.sh | bash stop.sh（不接受额外参数）'
fi
command -v systemctl >/dev/null 2>&1 || fail '这些脚本用于 Alibaba Cloud Linux 等 systemd 系统。请在 ECS 上执行；本地预览请运行 server.py。'
if ! LOAD_STATE="$(systemctl show "$UNIT" --property=LoadState --value)"; then
    fail '无法连接 systemd，请在 ECS 主机上执行。'
fi
if [[ "$LOAD_STATE" == not-found ]]; then
    case "$ACTION" in
        start)
            printf '服务尚未安装，正在执行首次安装…\n'
            bash "$PROJECT_DIR/install.sh"
            LOAD_STATE="$(systemctl show "$UNIT" --property=LoadState --value)"
            ;;
        stop) printf '服务尚未安装，无需关闭。\n'; exit 0 ;;
        restart) fail '服务尚未安装，请先运行 bash start.sh 自动安装并启动，或运行 bash install.sh 单独安装。' ;;
    esac
fi
[[ "$LOAD_STATE" == loaded ]] || fail "服务不可加载（${LOAD_STATE}），请检查 systemd 配置；未覆盖或取消屏蔽。"

# 不覆盖现有单元，也不操作指向其他 Git 目录的同名服务。
WORK_DIR="$(systemctl show "$UNIT" --property=WorkingDirectory --value)"
if [[ -z "$WORK_DIR" ]] || ! SERVICE_DIR="$(cd -- "$WORK_DIR" && pwd -P)"; then
    fail '无法读取服务的工作目录，请检查 systemd 的 WorkingDirectory 和目录权限。'
fi
[[ "$SERVICE_DIR" == "$PROJECT_DIR" ]] || fail "同名服务指向 ${WORK_DIR}，与当前项目 $PROJECT_DIR 不一致，未执行操作。"

CONTROL=(systemctl)
if [[ "$EUID" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || fail '需要 root 权限或 sudo 才能管理系统服务。'
    CONTROL=(sudo systemctl)
fi

if [[ "$ACTION" != stop ]]; then
    command -v curl >/dev/null 2>&1 || fail '缺少 curl，请先执行：sudo dnf install -y curl'
    PYTHON="$PROJECT_DIR/.venv/bin/python"
    [[ -x "$PYTHON" ]] || fail '缺少 .venv/bin/python，请先按服务部署说明安装 Python 依赖。'
    START_COMMAND="$(systemctl show "$UNIT" --property=ExecStart --value)"
    PORT=8080
    if [[ "$START_COMMAND" =~ --port[=[:space:]]+([0-9]+) ]]; then
        PORT="${BASH_REMATCH[1]}"
    fi
fi

if [[ "$ACTION" == restart || "$ACTION" == stop ]]; then
    printf '正在%s服务；未完成的采集任务将中断，已发布的数据和口令会保留。\n' "$([[ "$ACTION" == restart ]] && printf '重启' || printf '关闭')"
fi
if ! "${CONTROL[@]}" "$ACTION" "$UNIT"; then
    logs_hint
    fail '服务操作失败。'
fi

if [[ "$ACTION" == stop ]]; then
    ACTIVE_STATE="$(systemctl show "$UNIT" --property=ActiveState --value)"
    [[ "$ACTIVE_STATE" == inactive || "$ACTIVE_STATE" == failed ]] || fail "服务尚未停止，当前状态：$ACTIVE_STATE"
    printf '服务已关闭。再次启动：bash "%s/start.sh"\n' "$PROJECT_DIR"
    exit 0
fi

# Type=simple 启动命令返回时，HTTP 监听可能还没就绪。
DEADLINE=$((SECONDS + 30))
while (( SECONDS < DEADLINE )); do
    if systemctl is-active --quiet "$UNIT" &&
        curl --noproxy '*' --fail --silent --max-time 2 "http://127.0.0.1:$PORT/api/health" |
        "$PYTHON" -c 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("ok") is True and data.get("serverUpdates") is True else 1)' 2>/dev/null; then
        printf '服务已就绪，访问：http://你的公网IP:%s/\n' "$PORT"
        printf '查看日志：sudo journalctl -u %s -f\n' "$UNIT"
        exit 0
    fi
    sleep 1
done
logs_hint
fail "30 秒内未通过健康检查（端口 ${PORT}）。服务可能仍在启动或重试，请检查日志和端口占用。"

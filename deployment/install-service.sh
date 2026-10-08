#!/usr/bin/env bash
# 仅安装本项目的 systemd 服务；不启动服务、不更改 Nginx 或防火墙。
set -Eeuo pipefail
umask 022
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
UNIT=kpl-insight.service
SERVICE_USER=kpl-insight
UNIT_FILE="/etc/systemd/system/$UNIT"
RUNTIME="$PROJECT_DIR/runtime"
PYTHON="$PROJECT_DIR/.venv/bin/python"
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 0 ]] || fail '用法：bash install.sh（不接受额外参数）'
command -v systemctl >/dev/null 2>&1 || fail '安装脚本需要 systemd，请在 Alibaba Cloud Linux ECS 上执行。'
if [[ "$EUID" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || fail '安装服务需要 root 权限或 sudo。'
fi
as_root() { if [[ "$EUID" == 0 ]]; then "$@"; else sudo "$@"; fi; }
trap 'printf "安装未完成，请处理上方报错后重新运行 bash install.sh。\n" >&2' ERR

# 同步可能已由管理员复制的单元，防止覆盖尚未 reload 的现有配置。
as_root systemctl daemon-reload
LOAD_STATE="$(systemctl show "$UNIT" --property=LoadState --value)"
if [[ "$LOAD_STATE" == loaded ]]; then
    WORK_DIR="$(systemctl show "$UNIT" --property=WorkingDirectory --value)"
    if [[ -z "$WORK_DIR" ]] || ! EXISTING_DIR="$(cd -- "$WORK_DIR" && pwd -P)"; then
        fail '现有服务工作目录不可访问，请检查 WorkingDirectory。'
    fi
    [[ "$EXISTING_DIR" == "$PROJECT_DIR" ]] || fail "同名服务指向 ${WORK_DIR}，未覆盖。请使用对应项目的脚本。"
    printf '服务已安装，保留现有配置、依赖和运行状态。启动请运行：bash start.sh\n'
    exit 0
fi
[[ "$LOAD_STATE" == not-found ]] || fail "服务当前状态为 ${LOAD_STATE}，请先检查 systemd 配置；未覆盖现有服务。"
[[ ! -e "$UNIT_FILE" && ! -L "$UNIT_FILE" ]] || fail "${UNIT_FILE} 已存在但不可加载，请先检查该文件；未覆盖。"
[[ ! -L "$RUNTIME" && ! -L "$PROJECT_DIR/.venv" ]] || fail 'runtime 和 .venv 不能是符号链接，请检查目录后重试。'
for required in server.py update_service.py requirements.txt dist/index.html deployment/kpl-insight.service deployment/render-service.py; do
    [[ -f "$PROJECT_DIR/$required" ]] || fail "缺少 ${required}，请先拉取完整项目代码。"
done

check_port() {
    local listeners
    listeners="$(ss -H -ltn 'sport = :8080')" || fail '无法检查 8080 端口占用。'
    [[ -z "$listeners" ]] || fail '8080 端口已被占用。请用 sudo ss -lntp 查看；若由 Nginx 占用，请先释放该站点端口，再重新安装。脚本不会关闭其他服务。'
}
if command -v ss >/dev/null 2>&1; then check_port; fi

MISSING=0
for dependency in python3 curl setfacl runuser useradd groupadd getent ss; do
    command -v "$dependency" >/dev/null 2>&1 || MISSING=1
done
if command -v python3 >/dev/null 2>&1 && ! python3 -m pip --version >/dev/null 2>&1; then MISSING=1; fi
if [[ "$MISSING" == 1 ]]; then
    command -v dnf >/dev/null 2>&1 || fail '缺少系统依赖且找不到 dnf，请先安装 Python 3.9+、pip、curl、acl、iproute、util-linux 和 shadow-utils。'
    printf '正在安装缺少的系统依赖…\n'
    as_root dnf install -y python3 python3-pip curl acl iproute util-linux shadow-utils
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "服务需要 Python 3.9 或更新版本。")'
check_port

# 先校验并生成当前 Git 路径的单元，再安装项目依赖或改目录权限。
TEMP_UNIT="$(mktemp)"
trap 'rm -f -- "$TEMP_UNIT"' EXIT
python3 "$PROJECT_DIR/deployment/render-service.py" "$PROJECT_DIR" > "$TEMP_UNIT"

# 拒绝接管同一 runtime 中手工启动、仍在采集的进程。
as_root python3 - "$RUNTIME" <<'PY'
import fcntl
from pathlib import Path
import sys
lock = Path(sys.argv[1]) / "manager.lock"
if lock.exists():
    with lock.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit("runtime 正被另一服务使用，请先正常关闭旧服务再安装。")
PY

printf '正在准备项目虚拟环境和 Python 依赖…\n'
if [[ ! -x "$PYTHON" ]]; then as_root python3 -m venv "$PROJECT_DIR/.venv"; fi
as_root "$PYTHON" -m pip install --disable-pip-version-check -r "$PROJECT_DIR/requirements.txt"

if ! getent group "$SERVICE_USER" >/dev/null; then as_root groupadd --system "$SERVICE_USER"; fi
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    as_root useradd --system --gid "$SERVICE_USER" --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi
[[ "$(id -u "$SERVICE_USER")" != 0 ]] || fail 'kpl-insight 用户不能使用 root 的 UID。'

# 父目录只开放穿越权限；源码所有者不变，仅 runtime 交给服务用户写入。
PARENT="$(dirname -- "$PROJECT_DIR")"
while [[ "$PARENT" != / ]]; do
    as_root setfacl -m "u:$SERVICE_USER:--x" "$PARENT"
    PARENT="$(dirname -- "$PARENT")"
done
as_root setfacl -m "u:$SERVICE_USER:r-x" "$PROJECT_DIR"
as_root setfacl -m "u:$SERVICE_USER:r--" "$PROJECT_DIR/"*.py "$PROJECT_DIR/demacia-gol-facts.json"
as_root setfacl -R -P -m "u:$SERVICE_USER:rX" "$PROJECT_DIR/.venv" "$PROJECT_DIR/dist" "$PROJECT_DIR/data-sources"
as_root install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 700 "$RUNTIME"
as_root chown -R -P "$SERVICE_USER:$SERVICE_USER" "$RUNTIME"
as_root runuser -u "$SERVICE_USER" -- "$PYTHON" -c 'import flask, waitress'
as_root runuser -u "$SERVICE_USER" -- test -r "$PROJECT_DIR/dist/index.html"
as_root runuser -u "$SERVICE_USER" -- test -r "$PROJECT_DIR/server.py"

# 临时单元不包含管理口令，安装前再检查是否出现了已有配置。
[[ ! -e "$UNIT_FILE" && ! -L "$UNIT_FILE" ]] || fail '安装期间出现了同名服务文件，未覆盖，请重新运行安装脚本检查。'
as_root install -m 644 "$TEMP_UNIT" "$UNIT_FILE"
as_root systemctl daemon-reload
as_root systemctl enable "$UNIT"
printf '安装完成，已设置开机自启。现在运行：bash start.sh\n'
printf '默认访问地址：http://你的公网IP:8080/（阿里云安全组需放行 TCP 8080）。\n'

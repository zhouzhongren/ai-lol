#!/usr/bin/env python3
"""Serve the dashboard and authenticated background updates without Nginx."""
from __future__ import annotations

import argparse
import errno
import hmac
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import signal
import stat
import sys
from urllib.parse import urlsplit
import zlib

try:
    from flask import Flask, Response, abort, jsonify, request, send_file
    from werkzeug.exceptions import HTTPException
except ImportError as error:
    raise SystemExit("服务依赖未安装，请执行：python3 -m pip install -r requirements.txt") from error

from update_service import UpdateBusyError, UpdateManager


DATA_FILES = frozenset({"data.json", "lol-data.json", "lol-events.json", "champions.json"})
MAX_BODY_BYTES = 1024
TOKEN_PATTERN = re.compile(r"[\x21-\x7e]{24,256}\Z")


def validate_token(value: str) -> str:
    """Reject unusable secrets without including them in any error message."""
    if not isinstance(value, str) or not TOKEN_PATTERN.fullmatch(value):
        raise ValueError("管理口令必须为 24–256 个不含空白的 ASCII 字符。")
    return value


def load_admin_token(runtime_dir: Path) -> tuple[str, Path | None]:
    configured = os.environ.get("KPL_ADMIN_TOKEN")
    if configured is not None:
        return validate_token(configured), None

    token_path = runtime_dir / "admin-token"
    try:
        runtime_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            descriptor = None
        if descriptor is not None:
            with os.fdopen(descriptor, "w", encoding="ascii") as handle:
                handle.write(secrets.token_urlsafe(32) + "\n")
                handle.flush()
                os.fsync(handle.fileno())

        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(token_path, flags)
        with os.fdopen(descriptor, "r", encoding="ascii") as handle:
            file_stat = os.fstat(handle.fileno())
            if not stat.S_ISREG(file_stat.st_mode):
                raise ValueError("管理口令文件必须是普通文件。")
            if file_stat.st_size > 258:
                raise ValueError("管理口令文件内容过长。")
            os.fchmod(handle.fileno(), 0o600)
            value = handle.read(258).rstrip("\r\n")
        return validate_token(value), token_path
    except (OSError, UnicodeError) as error:
        raise ValueError(f"无法创建或读取管理口令文件 {token_path}；请检查运行用户的目录权限。") from error


def _origin(value: str):
    """Compare origins, including effective ports, without trusting proxy headers."""
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path or parsed.query or parsed.fragment):
            return None
        return parsed.scheme, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None


def _safe_file(directory: Path, filename: str) -> Path:
    # Reject traversal and symlinks before opening any public file.
    path = PurePosixPath(filename)
    if (not filename or "\\" in filename or "\x00" in filename or path.is_absolute()
            or any(part.startswith(".") for part in path.parts)):
        abort(404)
    base = directory.resolve()
    candidate = base
    for part in path.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            abort(404)
    try:
        resolved = candidate.resolve()
        resolved.relative_to(base)
        if not resolved.is_file():
            abort(404)
    except (OSError, ValueError, RuntimeError):
        abort(404)
    return resolved


def _data_response(path: Path):
    """Stream compression so large match histories need no unbounded cache."""
    if request.accept_encodings["gzip"] <= 0 or path.stat().st_size < 1024:
        response = send_file(path, conditional=True, max_age=0)
    else:
        handle = path.open("rb")

        def compressed():
            compressor = zlib.compressobj(level=4, wbits=31)
            try:
                while chunk := handle.read(65536):
                    output = compressor.compress(chunk)
                    if output:
                        yield output
                yield compressor.flush()
            finally:
                handle.close()

        response = Response(compressed(), mimetype="application/json")
        response.headers["Content-Encoding"] = "gzip"
        response.call_on_close(handle.close)
    response.vary.add("Accept-Encoding")
    return response


def create_app(root: Path | None = None, runtime_dir: Path | None = None,
               manager=None, token: str | None = None) -> Flask:
    root = (Path(root) if root is not None else Path(__file__).parent).resolve()
    static_dir = root / "dist"
    runtime_dir = (Path(runtime_dir) if runtime_dir is not None else root / "runtime").resolve()
    if runtime_dir == root:
        raise ValueError("runtime 目录必须独立于源码根目录。")
    try:
        runtime_dir.relative_to(static_dir.resolve())
    except ValueError:
        pass
    else:
        raise ValueError("runtime 目录不能放在公开的 dist 目录内。")
    if not (static_dir / "index.html").is_file():
        raise ValueError(f"缺少网站首页：{static_dir / 'index.html'}")

    if token is None:
        admin_token, token_path = load_admin_token(runtime_dir)
    else:
        admin_token, token_path = validate_token(token), None
    manager = manager if manager is not None else UpdateManager(root, runtime_dir)
    app = Flask(__name__, static_folder=None)
    app.config.update(MAX_CONTENT_LENGTH=MAX_BODY_BYTES, ADMIN_TOKEN_FILE=token_path)
    app.json.ensure_ascii = False
    app.extensions["update_manager"] = manager

    @app.before_request
    def protect_updates():
        if request.path != "/api/updates":
            return None
        origin = request.headers.get("Origin")
        if origin is not None and (_origin(origin) is None or _origin(origin) != _origin(request.host_url.rstrip("/"))):
            return jsonify(error="不允许跨站点调用更新接口。"), 403
        authorization = request.headers.get("Authorization", "")
        parts = authorization.split(" ", 1)
        supplied = parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else ""
        if not hmac.compare_digest(supplied.encode("utf-8"), admin_token.encode("ascii")):
            response = jsonify(error="请提供有效的管理口令。")
            response.status_code = 401
            response.headers["WWW-Authenticate"] = "Bearer"
            return response
        if request.args:
            return jsonify(error="此接口不接受 URL 参数。"), 400
        return None

    @app.after_request
    def response_headers(response):
        response.headers["Cache-Control"] = "no-store" if request.path.startswith("/api/") else "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        return response

    @app.errorhandler(HTTPException)
    def http_error(error):
        messages = {400: "请求格式错误。", 404: "文件或接口不存在。", 405: "请求方法不支持。",
                    413: "请求内容过大。", 415: "请使用 application/json 提交请求。"}
        return jsonify(error=messages.get(error.code, "请求失败。")), error.code

    @app.get("/api/health")
    def health():
        return jsonify(ok=True, serverUpdates=True)

    @app.get("/api/snapshot")
    def snapshot():
        return jsonify(version=manager.data_dir().name)

    @app.get("/api/updates")
    def update_status():
        return jsonify(job=manager.status())

    @app.post("/api/updates")
    def start_update():
        if request.mimetype != "application/json":
            abort(415)
        data = request.get_json()
        if (not isinstance(data, dict) or set(data) != {"game"}
                or not isinstance(data["game"], str) or data["game"] not in {"kpl", "lol"}):
            return jsonify(error="仅支持 game 参数，取值为 kpl 或 lol。"), 400
        try:
            job = manager.start(data["game"])
        except UpdateBusyError:
            return jsonify(error="已有更新任务正在进行，请等待完成。", job=manager.status()), 409
        return jsonify(job=job), 202

    @app.get("/", defaults={"filename": "index.html"})
    @app.get("/<path:filename>")
    def static_file(filename):
        # Unknown API routes must never fall through to published files.
        if filename == "api" or filename.startswith("api/"):
            abort(404)
        directory = manager.data_dir() if filename in DATA_FILES else static_dir
        path = _safe_file(directory, filename)
        try:
            if filename in DATA_FILES:
                return _data_response(path)
            return send_file(path, conditional=True, max_age=0)
        except (FileNotFoundError, PermissionError):
            abort(404)

    return app


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="启动 KPL Insight 页面和数据更新服务（无需 Nginx）")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    parser.add_argument("--port", type=int, default=8080, help="监听端口，默认 8080")
    parser.add_argument("--runtime-dir", type=Path, help="可写运行数据目录，默认项目内 runtime")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间。")

    app = None
    web_server = None
    previous_handlers = {}
    try:
        from waitress import create_server

        app = create_app(runtime_dir=args.runtime_dir)
        web_server = create_server(app, host=args.host, port=args.port, threads=4,
                                   max_request_body_size=MAX_BODY_BYTES,
                                   max_request_header_size=16384,
                                   channel_timeout=30, expose_tracebacks=False)

        def stop(signum, frame):
            raise SystemExit(0)

        for signum in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[signum] = signal.signal(signum, stop)
        print(f"KPL Insight 已启动：http://{args.host}:{args.port}/", flush=True)
        token_path = app.config["ADMIN_TOKEN_FILE"]
        if token_path:
            print(f"管理口令文件：{token_path}（仅在服务器本地读取；请勿公开）", flush=True)
        else:
            print("管理口令由 KPL_ADMIN_TOKEN 环境变量提供。", flush=True)
        web_server.run()
        return 0
    except ImportError:
        print("服务依赖未安装，请执行：python3 -m pip install -r requirements.txt", file=sys.stderr)
        return 1
    except (OSError, ValueError, RuntimeError) as error:
        if isinstance(error, OSError) and error.errno == errno.EADDRINUSE:
            print(f"启动失败：端口 {args.port} 已被占用，请关闭占用该端口的服务或修改 --port。", file=sys.stderr)
        else:
            print(f"启动失败：{error}", file=sys.stderr)
        return 1
    finally:
        if app is not None:
            app.extensions["update_manager"].close()
        if web_server is not None:
            web_server.close()
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)


if __name__ == "__main__":
    raise SystemExit(main())

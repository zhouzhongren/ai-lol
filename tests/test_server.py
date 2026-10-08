"""Offline API, file-isolation and administrator-token regression tests."""
import gzip
import errno
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from server import create_app, load_admin_token, main
from update_service import UpdateBusyError


TOKEN = "test-only-admin-secret-at-least-24-characters"


class FakeManager:
    def __init__(self, directory):
        self.directory = directory
        self.job = None
        self.calls = []

    def data_dir(self):
        return self.directory

    def status(self):
        return self.job

    def start(self, game):
        if self.job and self.job["status"] in {"queued", "running"}:
            raise UpdateBusyError()
        self.calls.append(game)
        self.job = {"id": "test-job", "game": game, "status": "queued", "stage": "queued",
                    "message": "等待更新", "logs": [], "startedAt": None, "finishedAt": None}
        return self.job


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<h1>Dashboard</h1>")
        (self.dist / "app.js").write_text("console.log('dashboard')")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.published = self.runtime / "snapshot-test"
        self.published.mkdir()
        for filename in ("data.json", "lol-data.json", "lol-events.json", "champions.json"):
            (self.dist / filename).write_text('{"source":"git"}')
            (self.published / filename).write_text('{"source":"published"}')
        self.manager = FakeManager(self.published)
        self.app = create_app(self.root, self.runtime, self.manager, TOKEN)
        self.app.testing = True
        self.client = self.app.test_client()
        self.auth = {"Authorization": "Bearer " + TOKEN}

    def test_public_health_and_snapshot(self):
        response = self.client.get("/api/health")
        self.assertEqual(response.json, {"ok": True, "serverUpdates": True})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(self.client.get("/api/snapshot").json, {"version": "snapshot-test"})

    def test_status_and_update_require_bearer_token(self):
        for headers in ({}, {"Authorization": "Bearer invalid"}, {"Authorization": "Basic " + TOKEN},
                        {"Authorization": "Bearer 中文错误口令"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.get("/api/updates", headers=headers).status_code, 401)
                self.assertEqual(self.client.post("/api/updates", json={"game": "kpl"}, headers=headers).status_code, 401)
        self.assertEqual(self.manager.calls, [])
        self.assertEqual(self.client.get("/api/updates", headers=self.auth).json, {"job": None})

    def test_each_game_is_accepted(self):
        for game in ("kpl", "lol"):
            self.manager.job = None
            response = self.client.post("/api/updates", json={"game": game}, headers=self.auth)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json["job"]["game"], game)
        self.assertEqual(self.manager.calls, ["kpl", "lol"])

    def test_busy_update_returns_current_job(self):
        first = self.client.post("/api/updates", json={"game": "kpl"}, headers=self.auth)
        second = self.client.post("/api/updates", json={"game": "lol"}, headers=self.auth)
        self.assertEqual(second.status_code, 409)
        self.assertEqual(second.json["job"], first.json["job"])
        self.assertEqual(self.manager.calls, ["kpl"])

    def test_cross_origin_requests_are_blocked(self):
        for origin in ("http://evil.example", "null", "https://localhost", "http://localhost:8080",
                       "http://localhost/path", "http://localhost@evil.example", "http://localhost:bad"):
            headers = {**self.auth, "Origin": origin}
            with self.subTest(origin=origin):
                self.assertEqual(self.client.post("/api/updates", json={"game": "kpl"}, headers=headers).status_code, 403)
                self.assertEqual(self.client.get("/api/updates", headers=headers).status_code, 403)
        self.assertEqual(self.manager.calls, [])

    def test_same_origin_and_cli_requests_are_allowed(self):
        for origin in (None, "http://localhost", "http://localhost:80"):
            headers = dict(self.auth)
            if origin:
                headers["Origin"] = origin
            self.assertEqual(self.client.get("/api/updates", headers=headers).status_code, 200)
        headers = {**self.auth, "Origin": "http://101.37.235.61:8080"}
        self.assertEqual(self.client.get("/api/updates", headers=headers,
                                        base_url="http://101.37.235.61:8080").status_code, 200)

    def test_forwarded_host_does_not_override_origin(self):
        headers = {**self.auth, "Origin": "http://evil.example", "X-Forwarded-Host": "evil.example"}
        self.assertEqual(self.client.get("/api/updates", headers=headers).status_code, 403)

    def test_cors_is_not_enabled(self):
        response = self.client.options("/api/updates", headers={"Origin": "http://evil.example",
                                                               "Access-Control-Request-Method": "POST"})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)

    def test_only_allowlisted_json_input_is_accepted(self):
        for body in ({}, {"game": "nope"}, {"game": "all"}, {"game": "kpl; echo unsafe"}, {"game": ["kpl"]},
                     {"game": None}, {"game": "kpl", "command": "echo unsafe"}, [], "kpl", None):
            with self.subTest(body=body):
                response = self.client.post("/api/updates", data=json.dumps(body),
                                            content_type="application/json", headers=self.auth)
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.manager.calls, [])

    def test_invalid_json_and_wrong_content_types_are_rejected(self):
        self.assertEqual(self.client.post("/api/updates", data="{", content_type="application/json",
                                         headers=self.auth).status_code, 400)
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "application/problem+json"):
            response = self.client.post("/api/updates", data='{"game":"kpl"}',
                                        content_type=content_type, headers=self.auth)
            self.assertEqual(response.status_code, 415)

    def test_body_limit_and_query_parameters_are_rejected(self):
        response = self.client.post("/api/updates", json={"game": "kpl", "pad": "a" * 2000}, headers=self.auth)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.client.get("/api/updates?token=" + TOKEN).status_code, 401)
        self.assertEqual(self.client.post("/api/updates?command=anything", json={"game": "kpl"},
                                         headers=self.auth).status_code, 400)
        self.assertEqual(self.manager.calls, [])

    def test_site_and_live_data_are_served_from_separate_directories(self):
        with self.client.get("/") as response:
            self.assertIn(b"Dashboard", response.data)
            self.assertEqual(response.headers["Cache-Control"], "no-cache")
        for filename in ("data.json", "lol-data.json", "lol-events.json", "champions.json"):
            with self.client.get("/" + filename) as response:
                self.assertEqual(response.json, {"source": "published"})
                self.assertIn("Accept-Encoding", response.headers["Vary"])
        with self.client.get("/app.js") as response:
            self.assertEqual(response.status_code, 200)
        self.manager.directory = self.dist
        with self.client.get("/data.json") as response:
            self.assertEqual(response.json, {"source": "git"})

    def test_json_gzip_stream_and_opt_out(self):
        data = json.dumps({"maps": ["测试数据"] * 400}).encode()
        (self.published / "data.json").write_bytes(data)
        with self.client.get("/data.json", headers={"Accept-Encoding": "gzip"}) as response:
            self.assertEqual(response.headers["Content-Encoding"], "gzip")
            self.assertEqual(gzip.decompress(response.data), data)
        with self.client.get("/data.json", headers={"Accept-Encoding": "gzip;q=0"}) as response:
            self.assertNotIn("Content-Encoding", response.headers)
            self.assertEqual(response.data, data)

    def test_private_files_traversal_and_directory_listing_are_not_exposed(self):
        (self.root / "secret").write_text(TOKEN)
        (self.dist / ".env").write_text(TOKEN)
        (self.dist / "assets").mkdir()
        for path in ("/../secret", "/%2e%2e/secret", "/%2eenv", "/.env", "/a/../../secret",
                     "/a%5c..%5csecret", "/server.py", "/runtime/admin-token", "/.git/config",
                     "/dist/index.html", "/assets", "/assets/", "/api/nonexistent"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 404)
                self.assertNotIn(TOKEN.encode(), response.data)

    def test_symlink_files_and_directories_are_not_exposed(self):
        (self.root / "secret").write_text(TOKEN)
        (self.dist / "linked.txt").symlink_to(self.root / "secret")
        (self.dist / "linked-dir").symlink_to(self.root, target_is_directory=True)
        (self.published / "data.json").unlink()
        (self.published / "data.json").symlink_to(self.root / "secret")
        for path in ("/linked.txt", "/linked-dir/secret", "/data.json"):
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_runtime_inside_public_dist_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "runtime"):
            create_app(self.root, self.dist / "runtime", self.manager, TOKEN)

    def test_runtime_at_source_root_is_rejected_before_token_creation(self):
        with self.assertRaisesRegex(ValueError, "runtime"):
            create_app(self.root, self.root, self.manager)
        self.assertFalse((self.root / "admin-token").exists())


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = Path(self.temp.name) / "runtime"
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_generated_token_is_private_and_persistent(self):
        first, path = load_admin_token(self.runtime)
        second, same_path = load_admin_token(self.runtime)
        self.assertEqual(first, second)
        self.assertEqual(path, same_path)
        self.assertGreaterEqual(len(first), 24)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_environment_token_does_not_need_a_file(self):
        with patch.dict(os.environ, {"KPL_ADMIN_TOKEN": TOKEN}):
            self.assertEqual(load_admin_token(self.runtime), (TOKEN, None))
        self.assertFalse(self.runtime.exists())

    def test_invalid_environment_tokens_fail_without_leaking_secret(self):
        for value in ("short-secret", "", "secret " * 10, "密" * 30, "x" * 257):
            with self.subTest(value=value), patch.dict(os.environ, {"KPL_ADMIN_TOKEN": value}):
                with self.assertRaises(ValueError) as raised:
                    load_admin_token(self.runtime)
                if value:
                    self.assertNotIn(value, str(raised.exception))

    def test_existing_invalid_file_is_not_silently_replaced(self):
        self.runtime.mkdir()
        token_path = self.runtime / "admin-token"
        token_path.write_text("invalid")
        with self.assertRaises(ValueError):
            load_admin_token(self.runtime)
        self.assertEqual(token_path.read_text(), "invalid")

    def test_symlink_token_file_is_rejected(self):
        self.runtime.mkdir()
        target = self.runtime.parent / "private-file"
        target.write_text(TOKEN)
        (self.runtime / "admin-token").symlink_to(target)
        with self.assertRaises(ValueError):
            load_admin_token(self.runtime)

    def test_large_token_file_cannot_hide_data_after_a_valid_prefix(self):
        self.runtime.mkdir()
        (self.runtime / "admin-token").write_text("x" * 256 + "\n\nextra")
        with self.assertRaises(ValueError):
            load_admin_token(self.runtime)


class StartupTests(unittest.TestCase):
    def test_help_does_not_initialize_runtime(self):
        with patch("server.create_app") as create, patch("sys.stdout", new=io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                main(["--help"])
        self.assertEqual(raised.exception.code, 0)
        create.assert_not_called()

    def test_port_conflict_closes_manager_and_reports_actionable_error(self):
        manager = MagicMock()
        app = MagicMock()
        app.extensions = {"update_manager": manager}
        with patch("server.create_app", return_value=app), \
                patch("waitress.create_server", side_effect=OSError(errno.EADDRINUSE, "in use")), \
                patch("sys.stderr", new=io.StringIO()) as output:
            code = main(["--port", "8080"])
        self.assertEqual(code, 1)
        self.assertIn("8080", output.getvalue())
        self.assertIn("占用", output.getvalue())
        manager.close.assert_called_once()

    def test_normal_server_exit_closes_resources_without_logging_token(self):
        manager = MagicMock()
        app = MagicMock()
        app.extensions = {"update_manager": manager}
        app.config = {"ADMIN_TOKEN_FILE": Path("/runtime/admin-token")}
        web = MagicMock()
        with patch("server.create_app", return_value=app), \
                patch("waitress.create_server", return_value=web) as create_server, \
                patch("sys.stdout", new=io.StringIO()) as output:
            code = main([])
        self.assertEqual(code, 0)
        self.assertEqual(create_server.call_args.kwargs["port"], 8080)
        self.assertEqual(create_server.call_args.kwargs["max_request_body_size"], 1024)
        web.run.assert_called_once()
        web.close.assert_called_once()
        manager.close.assert_called_once()
        self.assertIn("/runtime/admin-token", output.getvalue())
        self.assertNotIn(TOKEN, output.getvalue())


if __name__ == "__main__":
    unittest.main()

"""Exercise lifecycle scripts offline, without contacting the host's systemd."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ServiceScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.project = self.directory / "project with spaces"
        (self.project / "deployment").mkdir(parents=True)
        for name in ("start.sh", "restart.sh", "stop.sh", "deployment/service-control.sh"):
            shutil.copy2(ROOT / name, self.project / name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.calls = self.directory / "calls.jsonl"
        self.config = self.directory / "config.json"
        self.settings = {
            "LoadState": "loaded",
            "WorkingDirectory": str(self.project),
            "ExecStart": "{ path=/python ; argv[]=/python server.py --port 8080 ; }",
            "ActiveState": "inactive",
        }
        # PATH is deliberately closed: no real systemctl, sudo, curl or kill
        # can be reached, even if a future script adds an unexpected command.
        for name in ("bash", "dirname"):
            (self.bin / name).symlink_to(shutil.which(name))
        self.stub("systemctl", """
if args[0] == 'show':
    if config.get('show_failure'):
        sys.exit(1)
    prop = next(arg.split('=', 1)[1] for arg in args if arg.startswith('--property='))
    print(config[prop])
elif args[0] in ('start', 'restart', 'stop'):
    sys.exit(config.get('action_exit', 0))
elif args[0] == 'is-active':
    sys.exit(0)
else:
    sys.exit(91)
""")
        self.stub("sudo", """
if not args or args[0] != 'systemctl':
    sys.exit(92)
os.execvp(args[0], args)
""")
        self.stub("curl", "print(json.dumps({'ok': True, 'serverUpdates': True}))\n")
        for name in ("kill", "pkill", "killall", "sleep"):
            self.stub(name, "sys.exit(93)\n")
        python = self.project / ".venv" / "bin" / "python"
        python.parent.mkdir(parents=True)
        python.symlink_to(sys.executable)

    def stub(self, name, body):
        program = self.bin / name
        program.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            "config = json.loads(Path(os.environ['TEST_CONFIG']).read_text())\n"
            "with open(os.environ['TEST_CALLS'], 'a') as output:\n"
            f"    output.write(json.dumps([{name!r}, *args]) + '\\n')\n"
            + body,
            encoding="utf-8",
        )
        program.chmod(0o755)

    def run_script(self, name, *arguments):
        self.config.write_text(json.dumps(self.settings), encoding="utf-8")
        env = {**os.environ, "PATH": str(self.bin), "TEST_CONFIG": str(self.config),
               "TEST_CALLS": str(self.calls)}
        # A different cwd also guards against scripts accidentally depending on
        # the operator having run cd /root/project/ai-lol first.
        result = subprocess.run(
            [str(self.bin / "bash"), str(self.project / name), *arguments],
            cwd=self.directory, env=env, capture_output=True, text=True, timeout=5,
        )
        self.recorded = [json.loads(line) for line in self.calls.read_text().splitlines()] \
            if self.calls.exists() else []
        self.assertFalse(any(call[0] in {"kill", "pkill", "killall"} for call in self.recorded))
        return result

    def actions(self):
        return [call[1] for call in self.recorded
                if call[0] == "systemctl" and call[1] in {"start", "restart", "stop"}]

    def test_start_uses_installed_port_and_waits_for_service_health(self):
        self.settings["ExecStart"] = "{ path=/python ; argv[]=/python server.py --port 9091 ; }"
        result = self.run_script("start.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["start"])
        curl = next(call for call in self.recorded if call[0] == "curl")
        self.assertIn("http://127.0.0.1:9091/api/health", curl)
        self.assertIn("http://你的公网IP:9091/", result.stdout)
        if os.geteuid() != 0:
            self.assertIn(["sudo", "systemctl", "start", "kpl-insight.service"], self.recorded)

    def test_restart_recognizes_equals_port_and_warns_about_running_updates(self):
        self.settings["ExecStart"] = "{ path=/python ; argv[]=/python server.py --port=18181 ; }"
        result = self.run_script("restart.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["restart"])
        self.assertTrue(any("http://127.0.0.1:18181/api/health" in call for call in self.recorded))
        self.assertIn("采集任务将中断", result.stdout)

    def test_uninstalled_unit_has_actionable_error_without_starting_anything(self):
        self.settings["LoadState"] = "not-found"
        result = self.run_script("start.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("服务未安装", result.stderr)
        self.assertIn("服务部署说明.md", result.stderr)
        self.assertEqual(self.actions(), [])

    def test_same_unit_name_for_another_checkout_is_not_operated(self):
        other = self.directory / "other checkout"
        other.mkdir()
        self.settings["WorkingDirectory"] = str(other)
        result = self.run_script("stop.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("不一致", result.stderr)
        self.assertEqual(self.actions(), [])

    def test_stop_works_without_curl_or_python_environment(self):
        (self.bin / "curl").unlink()
        shutil.rmtree(self.project / ".venv")
        result = self.run_script("stop.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), ["stop"])
        self.assertIn("服务已关闭", result.stdout)
        self.assertFalse(any(call[0] == "curl" for call in self.recorded))

    def test_failed_service_action_returns_error_without_health_probe_or_force_kill(self):
        self.settings["action_exit"] = 1
        result = self.run_script("restart.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.actions(), ["restart"])
        self.assertIn("journalctl", result.stderr)
        self.assertFalse(any(call[0] == "curl" for call in self.recorded))

    def test_stop_does_not_report_success_when_unit_remains_active(self):
        self.settings["ActiveState"] = "active"
        result = self.run_script("stop.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("服务尚未停止", result.stderr)
        self.assertEqual(self.actions(), ["stop"])


if __name__ == "__main__":
    unittest.main()

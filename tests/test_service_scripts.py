"""Exercise lifecycle scripts offline, without contacting the host's systemd."""
import json
import fcntl
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
        for name in ("install.sh", "start.sh", "restart.sh", "stop.sh",
                     "deployment/service-control.sh", "deployment/install-service.sh",
                     "deployment/render-service.py", "deployment/kpl-insight.service"):
            shutil.copy2(ROOT / name, self.project / name)
        for name in ("server.py", "update_service.py", "requirements.txt",
                     "demacia-gol-facts.json", "dist/index.html"):
            target = self.project / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("offline fixture\n", encoding="utf-8")
        (self.project / "data-sources").mkdir()
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.calls = self.directory / "calls.jsonl"
        self.config = self.directory / "config.json"
        self.installed_unit = self.directory / "installed.service"
        self.settings = {
            "LoadState": "loaded",
            "WorkingDirectory": str(self.project),
            "ExecStart": "{ path=/python ; argv[]=/python server.py --port 8080 ; }",
            "ActiveState": "inactive",
            "pip_available": True,
            "user_exists": True,
            "group_exists": True,
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
elif args[0] == 'daemon-reload':
    pass
elif args[0] == 'enable':
    assert args == ['enable', 'kpl-insight.service']
    assert Path(os.environ['TEST_INSTALLED_UNIT']).is_file()
    config['LoadState'] = 'loaded'
    Path(os.environ['TEST_CONFIG']).write_text(json.dumps(config))
else:
    sys.exit(91)
""")
        self.stub("sudo", """
allowed = {'systemctl', 'dnf', 'python3', 'setfacl', 'install', 'chown',
           'runuser', 'groupadd', 'useradd', str(Path(os.environ['TEST_PROJECT']) / '.venv/bin/python')}
if not args or args[0] not in allowed:
    sys.exit(92)
os.execvp(args[0], args)
""")
        self.stub("curl", "print(json.dumps({'ok': True, 'serverUpdates': True}))\n")
        for name in ("kill", "pkill", "killall", "sleep", "nginx", "firewall-cmd"):
            self.stub(name, "sys.exit(93)\n")
        self.stub("ss", "print('LISTEN 0 511 *:8080 *:*' if config.get('port_busy') else '', end='')\n")
        self.stub("dnf", """
assert args == ['install', '-y', 'python3', 'python3-pip', 'curl', 'acl', 'iproute', 'util-linux', 'shadow-utils']
if config.get('dnf_exit'):
    sys.exit(config['dnf_exit'])
config['pip_available'] = True
Path(os.environ['TEST_CONFIG']).write_text(json.dumps(config))
""")
        self.stub("getent", """
assert args == ['group', 'kpl-insight']
sys.exit(0 if config['group_exists'] else 2)
""")
        self.stub("id", """
assert args == ['-u', 'kpl-insight']
if not config['user_exists']:
    sys.exit(1)
print(config.get('service_uid', 998))
""")
        for name, field in (("groupadd", "group_exists"), ("useradd", "user_exists")):
            self.stub(name, f"""
assert args[-1] == 'kpl-insight'
config[{field!r}] = True
Path(os.environ['TEST_CONFIG']).write_text(json.dumps(config))
""")
        self.stub("setfacl", "assert args[0] in ('-m', '-R')\n")
        self.stub("chown", """
assert args == ['-R', '-P', 'kpl-insight:kpl-insight', str(Path(os.environ['TEST_PROJECT']) / 'runtime')]
""")
        self.stub("install", """
if args[:1] == ['-d']:
    assert args == ['-d', '-o', 'kpl-insight', '-g', 'kpl-insight', '-m', '700', str(Path(os.environ['TEST_PROJECT']) / 'runtime')]
    Path(args[-1]).mkdir(exist_ok=True)
else:
    assert args[:2] == ['-m', '644']
    assert args[-1] == '/etc/systemd/system/kpl-insight.service'
    source = Path(args[-2]).resolve()
    assert source.parent == Path(os.environ['TEST_DIRECTORY'])
    Path(os.environ['TEST_INSTALLED_UNIT']).write_bytes(source.read_bytes())
""")
        self.stub("runuser", """
assert args[:3] == ['-u', 'kpl-insight', '--']
project = Path(os.environ['TEST_PROJECT'])
if args[3:5] == ['test', '-r']:
    assert args[5] in (str(project / 'server.py'), str(project / 'dist/index.html'))
    assert Path(args[5]).is_file()
else:
    assert args[3:] == [str(project / '.venv/bin/python'), '-c', 'import flask, waitress']
""")
        self.stub("mktemp", """
import tempfile
assert args == []
fd, name = tempfile.mkstemp(prefix='unit-', dir=os.environ['TEST_DIRECTORY'])
os.close(fd)
print(name)
""")
        self.stub("rm", """
assert args[:2] == ['-f', '--']
target = Path(args[2]).resolve()
assert target.parent == Path(os.environ['TEST_DIRECTORY']) and target.name.startswith('unit-')
target.unlink(missing_ok=True)
""")
        # Only fixed, local operations may reach the real Python interpreter.
        # In particular, neither a real pip nor a real venv command can run.
        self.stub("python3", """
project = Path(os.environ['TEST_PROJECT'])
if args == ['-m', 'pip', '--version']:
    sys.exit(0 if config['pip_available'] else 1)
elif args[:3] == ['-m', 'pip', 'install']:
    assert args == ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', str(project / 'requirements.txt')]
    sys.exit(config.get('pip_install_exit', 0))
elif args[:2] == ['-m', 'venv']:
    assert args == ['-m', 'venv', str(project / '.venv')]
    destination = project / '.venv/bin/python'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(Path(__file__).read_bytes())
    destination.chmod(0o755)
elif args == ['-', str(project / 'runtime')]:
    os.execv(sys.executable, [sys.executable, *args])
elif args == [str(project / 'deployment/render-service.py'), str(project)]:
    os.execv(sys.executable, [sys.executable, *args])
elif args == ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else "服务需要 Python 3.9 或更新版本。")']:
    os.execv(sys.executable, [sys.executable, *args])
elif args == ['-c', 'import json,sys; data=json.load(sys.stdin); sys.exit(0 if data.get("ok") is True and data.get("serverUpdates") is True else 1)']:
    os.execv(sys.executable, [sys.executable, *args])
else:
    raise AssertionError('Unapproved Python invocation: ' + repr(args))
""")
        python = self.project / ".venv/bin/python"
        python.parent.mkdir(parents=True)
        shutil.copy2(self.bin / "python3", python)

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
               "TEST_CALLS": str(self.calls), "TEST_PROJECT": str(self.project),
               "TEST_DIRECTORY": str(self.directory),
               "TEST_INSTALLED_UNIT": str(self.installed_unit),
               "PYTHONDONTWRITEBYTECODE": "1"}
        # A different cwd also guards against scripts accidentally depending on
        # the operator having run cd /root/project/ai-lol first.
        result = subprocess.run(
            [str(self.bin / "bash"), str(self.project / name), *arguments],
            cwd=self.directory, env=env, capture_output=True, text=True, timeout=15,
        )
        self.recorded = [json.loads(line) for line in self.calls.read_text().splitlines()] \
            if self.calls.exists() else []
        self.assertFalse(any(call[0] in {"kill", "pkill", "killall"} for call in self.recorded))
        self.assertFalse(any(call[0] in {"nginx", "firewall-cmd"} for call in self.recorded))
        self.assertFalse(any(call[0] == "systemctl" and "nginx" in " ".join(call)
                             for call in self.recorded))
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

    def test_start_installs_missing_unit_before_starting_and_checking_health(self):
        self.settings["LoadState"] = "not-found"
        result = self.run_script("start.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("首次安装", result.stdout)
        self.assertEqual(self.actions(), ["start"])
        enable = self.recorded.index(["systemctl", "enable", "kpl-insight.service"])
        start = self.recorded.index(["systemctl", "start", "kpl-insight.service"])
        self.assertLess(enable, start)
        self.assertTrue(any(call[0] == "curl" for call in self.recorded[start:]))

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

    def assert_not_installed(self):
        self.assertFalse(self.installed_unit.exists())
        self.assertNotIn(["systemctl", "enable", "kpl-insight.service"], self.recorded)
        self.assertEqual(self.actions(), [])

    def pip_installs(self):
        return [call for call in self.recorded if call[0] == "python3"
                and call[1:4] == ["-m", "pip", "install"]]

    def test_install_from_checkout_with_spaces_renders_unit_without_starting(self):
        self.settings.update(LoadState="not-found", user_exists=False, group_exists=False)
        shutil.rmtree(self.project / ".venv")
        result = self.run_script("install.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.actions(), [])
        self.assertEqual(len(self.pip_installs()), 1)
        self.assertIn(["python3", "-m", "venv", str(self.project / ".venv")], self.recorded)
        self.assertIn(["groupadd", "--system", "kpl-insight"], self.recorded)
        self.assertIn(["useradd", "--system", "--gid", "kpl-insight", "--no-create-home",
                       "--shell", "/sbin/nologin", "kpl-insight"], self.recorded)
        self.assertIn(["systemctl", "enable", "kpl-insight.service"], self.recorded)
        self.assertFalse(any(call[0] == "curl" for call in self.recorded))
        unit = self.installed_unit.read_text()
        self.assertIn(f"WorkingDirectory={self.project}\n", unit)
        self.assertIn(f'ExecStart="{self.project}/.venv/bin/python" "{self.project}/server.py" ', unit)
        self.assertIn(f'--runtime-dir "{self.project}/runtime"', unit)
        self.assertIn(f'ReadWritePaths="{self.project}/runtime"', unit)
        self.assertNotIn("/root/project/ai-lol", unit)
        self.assertFalse(any(call[0] == "dnf" for call in self.recorded))

    def test_install_fetches_system_dependencies_only_when_missing(self):
        self.settings.update(LoadState="not-found", pip_available=False)
        result = self.run_script("install.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        dnf = next(index for index, call in enumerate(self.recorded) if call[0] == "dnf")
        pip = self.recorded.index(self.pip_installs()[0])
        self.assertLess(dnf, pip)
        self.assertTrue(self.installed_unit.exists())

    def test_busy_port_does_not_install_or_stop_nginx(self):
        self.settings.update(LoadState="not-found", port_busy=True)
        result = self.run_script("start.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("8080 端口已被占用", result.stderr)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])
        self.assertFalse(any(call[0] in {"dnf", "chown", "setfacl"} for call in self.recorded))

    def test_pip_failure_never_publishes_or_enables_unit(self):
        self.settings.update(LoadState="not-found", pip_install_exit=1)
        result = self.run_script("start.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("安装未完成", result.stderr)
        self.assertEqual(len(self.pip_installs()), 1)
        self.assert_not_installed()
        self.assertFalse(any(call[0] in {"chown", "setfacl"} for call in self.recorded))

    def test_dnf_failure_never_installs_python_packages_or_service(self):
        self.settings.update(LoadState="not-found", pip_available=False, dnf_exit=1)
        result = self.run_script("install.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])

    def test_install_preserves_runtime_and_changes_ownership_only_there(self):
        self.settings["LoadState"] = "not-found"
        runtime = self.project / "runtime"
        (runtime / "snapshots/old").mkdir(parents=True)
        preserved = {
            runtime / "admin-token": b"existing-secret-token\n",
            runtime / "current.json": b'{"version":"old"}',
            runtime / "snapshots/old/data.json": b'{"games":[1]}',
            runtime / "manager.lock": b"",
        }
        for path, content in preserved.items():
            path.write_bytes(content)
        result = self.run_script("install.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        for path, content in preserved.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual([call for call in self.recorded if call[0] == "chown"],
                         [["chown", "-R", "-P", "kpl-insight:kpl-insight", str(runtime)]])
        self.assertNotIn("existing-secret-token", result.stdout + result.stderr)

    def test_install_refuses_runtime_owned_by_running_collector(self):
        self.settings["LoadState"] = "not-found"
        runtime = self.project / "runtime"
        runtime.mkdir()
        with (runtime / "manager.lock").open("w") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_script("install.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("runtime 正被另一服务使用", result.stderr)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])
        self.assertFalse(any(call[0] in {"chown", "setfacl"} for call in self.recorded))

    def test_install_preserves_loaded_unit_and_dependencies(self):
        self.settings["ActiveState"] = "active"
        self.installed_unit.write_text("existing customized unit\n")
        result = self.run_script("install.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("保留现有配置", result.stdout)
        self.assertEqual(self.installed_unit.read_text(), "existing customized unit\n")
        self.assertEqual(self.pip_installs(), [])
        self.assertEqual(self.actions(), [])
        self.assertFalse(any(call[0] in {"install", "dnf", "chown", "setfacl"} for call in self.recorded))
        self.assertNotIn(["systemctl", "enable", "kpl-insight.service"], self.recorded)

    def test_masked_service_is_not_unmasked_or_overwritten(self):
        for script in ("install.sh", "start.sh", "restart.sh", "stop.sh"):
            with self.subTest(script=script):
                self.calls.unlink(missing_ok=True)
                self.settings["LoadState"] = "masked"
                result = self.run_script(script)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("masked", result.stderr)
                self.assert_not_installed()
                self.assertEqual(self.pip_installs(), [])
                self.assertFalse(any(call[0] == "systemctl" and call[1] == "unmask"
                                     for call in self.recorded))

    def test_uninstalled_stop_is_successful_noop(self):
        self.settings["LoadState"] = "not-found"
        result = self.run_script("stop.sh")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("无需关闭", result.stdout)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])

    def test_uninstalled_restart_explains_start_without_installing(self):
        self.settings["LoadState"] = "not-found"
        result = self.run_script("restart.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bash start.sh", result.stderr)
        self.assertIn("bash install.sh", result.stderr)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])

    def test_install_refuses_runtime_symlink_before_touching_target(self):
        self.settings["LoadState"] = "not-found"
        target = self.directory / "unrelated"
        target.mkdir()
        (target / "data").write_text("preserve")
        (self.project / "runtime").symlink_to(target, target_is_directory=True)
        result = self.run_script("install.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("符号链接", result.stderr)
        self.assert_not_installed()
        self.assertEqual((target / "data").read_text(), "preserve")

    def test_install_does_not_replace_unit_for_another_checkout(self):
        other = self.directory / "other checkout"
        other.mkdir()
        self.settings["WorkingDirectory"] = str(other)
        result = self.run_script("install.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("未覆盖", result.stderr)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])

    def test_invalid_unit_path_fails_before_installing_dependencies_or_changing_permissions(self):
        self.settings["LoadState"] = "not-found"
        target = self.directory / "project%unsupported"
        self.project.rename(target)
        self.project = target
        self.settings["WorkingDirectory"] = str(target)
        result = self.run_script("install.sh")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("无法生成服务配置", result.stderr)
        self.assert_not_installed()
        self.assertEqual(self.pip_installs(), [])
        self.assertFalse(any(call[0] in {"chown", "setfacl", "useradd", "groupadd"}
                             for call in self.recorded))


if __name__ == "__main__":
    unittest.main()

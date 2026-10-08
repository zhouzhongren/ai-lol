"""Offline publication/collector tests; no public data requests are made."""

import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_service import (DATA_FILES, SCRIPTS, UpdateBusyError, UpdateManager,
                            UpdateValidationError, _validate_metadata,
                            _validate_snapshot)
import update_service


ROOT = Path(__file__).resolve().parents[1]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    before = path.stat().st_mtime_ns if path.exists() else 0
    path.write_text(json.dumps(value), encoding="utf-8")
    # Keep freshness checks deterministic even with coarse test filesystems.
    stamp = max(time.time_ns(), before + 1_000_000)
    os.utime(path, ns=(stamp, stamp))


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def snapshot(rows, missing=(), deficit=0):
    return {"rows": copy.deepcopy(rows), "fixtures": [], "metadata": {
        "actual_completed_maps": len(rows), "expected_completed_maps": len(rows) + deficit,
        "complete": not missing and not deficit, "missing": copy.deepcopy(list(missing)),
    }}


def lol_row(identity):
    roles = ("top", "jungle", "mid", "bottom", "support")
    return {"id": identity, "draft_verified": True,
            "lineup_a": dict(zip(roles, [f"hero{i}" for i in range(5)])),
            "lineup_b": dict(zip(roles, [f"hero{i}" for i in range(5, 10)]))}


def lol_data():
    rows = [lol_row("lol-tencent-1"), lol_row("lol-riot-1"), lol_row("lol-chaincc-1")]
    old_tencent_gap = {"match_id": "ewc-old", "reason": "official statistics unavailable"}
    old_global_gap = {"series_id": "lck-old", "missing_maps": [1], "observed_maps": [2]}
    base = snapshot(rows[:2], [old_tencent_gap], 1)["metadata"]
    base["demacia"] = snapshot(rows[1:2])["metadata"]
    global_report = snapshot(rows[2:], [old_global_gap], 1)["metadata"]
    global_report["normalizationIssues"] = []
    result = snapshot(rows, [old_tencent_gap, old_global_gap], 2)
    result["metadata"].update(globalBaseMetadata=base, demacia=base["demacia"],
                              globalRegions=global_report,
                              draftCoverage={"complete": True, "verifiedMaps": 3})
    return result


def fixture(root):
    (root / "dist").mkdir(parents=True)
    (root / "data-sources/ddragon").mkdir(parents=True)
    (root / "data-sources/ddragon/catalog.json").write_text("{}")
    write(root / "demacia-gol-facts.json", [])
    for name in SCRIPTS:
        (root / name).write_text("# fake collector, run by the test runner\n")
    write(root / "dist/data.json", snapshot([{"game_id": "kpl-1"}]))
    write(root / "dist/lol-data.json", lol_data())
    write(root / "dist/lol-events.json", {"fixtures": [], "tournaments": [],
          "coverage": {"worlds": {"observedSeries": 40, "complete": False},
                       "demacia": {"observedSeries": 27, "complete": True}}})
    write(root / "dist/champions.json", {"champions": [{"id": f"hero{i}"} for i in range(10)]})


class FakeManager(UpdateManager):
    def __init__(self, *args, hook=None, **kwargs):
        self.calls = []
        self.hook = hook
        super().__init__(*args, **kwargs)

    def _run_command(self, work, arguments):
        self.calls.append(arguments)
        if self.hook and self.hook(self, work, arguments):
            return
        script = arguments[0]
        previous = read(self.data_dir() / "lol-data.json")
        if script == "update-data.py":
            data = read(self.data_dir() / "data.json")
            data["rows"].append({"game_id": f"kpl-{len(data['rows']) + 1}"})
            write(work / "dist/data.json", snapshot(data["rows"]))
        elif script == "update-lol-events.py":
            write(work / "dist/lol-events.json", read(work / "dist/lol-events.json"))
        elif script == "update-lol-data.py":
            data = self._source_baseline(previous, "tencent")
            data["metadata"]["complete"] = not data["metadata"]["missing"]
            write(work / "cache/lol/tencent-data.json", data)
        elif script == "update-demacia-data.py":
            write(work / "cache/lol/demacia-data.json", self._source_baseline(previous, "riot"))
        elif script == "merge-lol-data.py":
            data = {"rows": previous["rows"][:2], "metadata": previous["metadata"]["globalBaseMetadata"]}
            write(work / "cache/lol/base-candidate.json", data)
        elif script == "enrich-lol-drafts.py":
            write(work / "cache/lol/base-enriched.json", read(work / "cache/lol/base-candidate.json"))
            write(work / "cache/lol/base-champions.json", read(work / "dist/champions.json"))
            write(work / "cache/lol/draft-coverage.json", {"complete": True, "outputWritten": True,
                  "missingMaps": 0, "droppedPreviouslyVerifiedMaps": 0, "verifiedMaps": 2})
        elif script == "update-global-lol-data.py":
            write(work / "dist/lol-data.json", previous)
            write(work / "dist/champions.json", read(work / "dist/champions.json"))
            write(work / "cache/global-lol/coverage-report.json", previous["metadata"]["globalRegions"])
            write(work / "cache/global-lol/integration-report.json", {"maps": len(previous["rows"])})
        else:
            raise AssertionError(f"Unexpected command: {arguments}")


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "repo"
        self.runtime = self.root / "runtime"
        fixture(self.root)

    def manager(self, klass=FakeManager, **kwargs):
        manager = klass(self.root, self.runtime, **kwargs)
        self.addCleanup(manager.close)
        return manager

    def done(self, manager, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = manager.status()
            if state and state["status"] not in {"queued", "running"}:
                if manager._thread:
                    manager._thread.join(timeout=1)
                return state
            time.sleep(0.01)
        self.fail(f"Update did not finish: {manager.status()}")

    def test_kpl_publish_preserves_repository_and_other_game(self):
        before = {name: (self.root / "dist" / name).read_bytes() for name in DATA_FILES}
        manager = self.manager()
        self.assertEqual(manager.data_dir(), self.root / "dist")
        job = manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "succeeded", state)
        self.assertEqual(state["id"], job["id"])
        self.assertEqual(len(read(manager.data_dir() / "data.json")["rows"]), 2)
        self.assertEqual(set(path.name for path in manager.data_dir().iterdir()), set(DATA_FILES))
        self.assertEqual([args[0] for args in manager.calls], ["update-data.py"])
        for name in DATA_FILES:
            self.assertEqual((self.root / "dist" / name).read_bytes(), before[name])
        for name in DATA_FILES[1:]:
            self.assertEqual((manager.data_dir() / name).read_bytes(), before[name])

    def test_nonzero_exit_never_replaces_published_generation(self):
        manager = self.manager()
        manager.start("kpl")
        self.done(manager)
        previous_dir = manager.data_dir()
        previous_pointer = (self.runtime / "current.json").read_bytes()
        def fail(_manager, work, arguments):
            write(work / "dist/data.json", snapshot([{"game_id": "wrong"}]))
            raise RuntimeError("collector failed")
        manager.hook = fail
        manager.start("kpl")
        self.assertEqual(self.done(manager)["status"], "failed")
        self.assertEqual(manager.data_dir(), previous_dir)
        self.assertEqual((self.runtime / "current.json").read_bytes(), previous_pointer)

    def test_zero_exit_with_incomplete_kpl_is_rejected(self):
        def incomplete(_manager, work, arguments):
            write(work / "dist/data.json", snapshot([{"game_id": "kpl-1"}], [{"match_id": "new"}], 1))
            return True
        manager = self.manager(hook=incomplete)
        manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertIn("新增缺失", state["message"])
        self.assertEqual(manager.data_dir(), self.root / "dist")

    def test_kpl_old_game_id_drop_and_duplicates_block_publication(self):
        for rows, fragment in (([{"game_id": "replacement"}], "丢失"),
                               ([{"game_id": "kpl-1"}] * 2, "重复")):
            with self.subTest(rows=rows):
                def bad(_manager, work, arguments):
                    write(work / "dist/data.json", snapshot(rows))
                    return True
                manager = self.manager(hook=bad)
                manager.start("kpl")
                state = self.done(manager)
                self.assertEqual(state["status"], "failed")
                self.assertIn(fragment, state["message"])
                manager.close()

    def test_lol_all_six_steps_allow_only_known_gaps(self):
        manager = self.manager()
        original_kpl = (self.root / "dist/data.json").read_bytes()
        manager.start("lol")
        state = self.done(manager)
        self.assertEqual(state["status"], "succeeded", state)
        self.assertEqual(len(manager.calls), 6)
        self.assertEqual(manager.calls[-1], ["update-global-lol-data.py", "--fetch", "--base", "cache/lol/base-enriched.json"])
        self.assertEqual((manager.data_dir() / "data.json").read_bytes(), original_kpl)
        self.assertFalse(read(manager.data_dir() / "lol-data.json")["metadata"]["complete"])

    def test_zero_exit_new_tencent_gap_stops_before_merge(self):
        def new_gap(manager, work, arguments):
            if arguments[0] != "update-lol-data.py":
                return False
            previous = read(manager.data_dir() / "lol-data.json")
            candidate = manager._source_baseline(previous, "tencent")
            candidate["metadata"]["missing"].append({"match_id": "new-series", "reason": "unavailable"})
            candidate["metadata"]["expected_completed_maps"] += 1
            write(work / "cache/lol/tencent-data.json", candidate)
            return True
        manager = self.manager(hook=new_gap)
        manager.start("lol")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertEqual(state["stage"], "lol-tencent")
        self.assertEqual(len(manager.calls), 2)
        self.assertEqual(manager.data_dir(), self.root / "dist")

    def test_zero_exit_missing_demacia_facts_preserves_previous(self):
        def no_facts(manager, work, arguments):
            if arguments[0] != "update-demacia-data.py":
                return False
            previous = read(manager.data_dir() / "lol-data.json")
            candidate = manager._source_baseline(previous, "riot")
            candidate["metadata"].update(complete=False, expected_completed_maps=2,
                                          missing=[{"match_id": "new-demacia", "error": "Missing reviewed duration facts"}])
            write(work / "cache/lol/demacia-data.json", candidate)
            return True
        manager = self.manager(hook=no_facts)
        manager.start("lol")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertEqual(state["stage"], "lol-demacia")
        self.assertIn("duration facts", state["message"])
        self.assertEqual(manager.data_dir(), self.root / "dist")

    def test_zero_exit_no_output_cannot_reuse_old_stage_artifact(self):
        manager = self.manager()
        manager.start("lol")
        self.assertEqual(self.done(manager)["status"], "succeeded")
        original = manager.data_dir()
        manager.hook = lambda _manager, work, arguments: arguments[0] == "update-lol-data.py"
        manager.start("lol")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertIn("未生成", state["message"])
        self.assertEqual(manager.data_dir(), original)

    def test_invalid_final_report_blocks_publication(self):
        manager = self.manager()
        original = manager._run_command
        def bad_report(work, arguments):
            original(work, arguments)
            if arguments[0] == "update-global-lol-data.py":
                write(work / "cache/global-lol/integration-report.json", {"maps": 999})
        manager._run_command = bad_report
        manager.start("lol")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertIn("合并报告", state["message"])

    def test_global_report_must_match_the_embedded_source_report(self):
        manager = self.manager()
        original = manager._run_command
        def bad_report(work, arguments):
            original(work, arguments)
            if arguments[0] == "update-global-lol-data.py":
                report = read(work / "cache/global-lol/coverage-report.json")
                report["fetchedAt"] = "a different report"
                write(work / "cache/global-lol/coverage-report.json", report)
        manager._run_command = bad_report
        manager.start("lol")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertIn("来源记录不一致", state["message"])

    def test_lol_final_old_ids_and_unverified_drafts_block_publication(self):
        for kind in ("dropped", "draft"):
            with self.subTest(kind=kind):
                manager = self.manager()
                original = manager._run_command
                def alter(work, arguments):
                    original(work, arguments)
                    if arguments[0] == "update-global-lol-data.py":
                        candidate = read(work / "dist/lol-data.json")
                        if kind == "dropped":
                            candidate["rows"][0]["id"] = "lol-tencent-replacement"
                        else:
                            candidate["rows"][0]["draft_verified"] = False
                        write(work / "dist/lol-data.json", candidate)
                manager._run_command = alter
                manager.start("lol")
                self.assertEqual(self.done(manager)["status"], "failed")
                self.assertEqual(manager.data_dir(), self.root / "dist")
                manager.close()

    def test_concurrent_start_is_rejected_and_status_is_detached(self):
        running, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def blocked(manager, work, arguments):
            running.set()
            release.wait(timeout=3)
            return False
        manager = self.manager(hook=blocked)
        manager.start("kpl")
        self.assertTrue(running.wait(timeout=2))
        state = manager.status()
        state["logs"].append("not real")
        self.assertNotIn("not real", manager.status()["logs"])
        with self.assertRaises(UpdateBusyError):
            manager.start("lol")
        release.set()
        self.assertEqual(self.done(manager)["status"], "succeeded")

    def test_second_service_cannot_share_runtime_lock(self):
        manager = self.manager()
        with self.assertRaisesRegex(RuntimeError, "另一个服务进程"):
            UpdateManager(self.root, self.runtime)
        manager.close()
        replacement = self.manager()
        self.assertIsNone(replacement.status())

    def test_restart_marks_unfinished_job_interrupted_and_keeps_data(self):
        manager = self.manager()
        manager.start("kpl")
        self.done(manager)
        published = manager.data_dir()
        manager.close()
        write(self.runtime / "job.json", {"id": "old-job", "game": "lol", "status": "running", "logs": [], "startedAt": "yesterday"})
        restarted = self.manager()
        self.assertEqual(restarted.status()["status"], "failed")
        self.assertEqual(restarted.status()["stage"], "interrupted")
        self.assertIsNotNone(restarted.status()["finishedAt"])
        self.assertEqual(restarted.data_dir(), published)

    def test_start_disk_failure_is_terminal_and_retryable(self):
        manager = self.manager()
        with patch("update_service._atomic_json", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                manager.start("kpl")
        self.assertEqual(manager.status()["status"], "failed")
        self.assertIsNone(manager._thread)
        self.assertFalse((self.runtime / "current.json").exists())
        manager.start("kpl")
        self.assertEqual(self.done(manager)["status"], "succeeded")

    def test_running_status_and_failure_log_disk_errors_do_not_leave_busy_job(self):
        manager = self.manager()
        original = update_service._atomic_json
        def disk_error(path, value):
            if path.name == "job.json" and value["status"] != "queued":
                raise OSError("job status disk full")
            return original(path, value)
        with patch("update_service._atomic_json", side_effect=disk_error):
            manager.start("kpl")
            state = self.done(manager)
        self.assertEqual(state["status"], "failed")
        self.assertFalse((self.runtime / "current.json").exists())
        manager.start("kpl")
        self.assertEqual(self.done(manager)["status"], "succeeded")

    def test_post_commit_status_disk_failure_stays_successful_and_recovers_on_restart(self):
        manager = self.manager()
        original = update_service._atomic_json
        def final_status_failure(path, value):
            if path.name == "job.json" and value["status"] == "succeeded":
                raise OSError("cannot save success")
            return original(path, value)
        with patch("update_service._atomic_json", side_effect=final_status_failure):
            manager.start("kpl")
            state = self.done(manager)
            self.assertEqual(state["status"], "succeeded", state)
            self.assertEqual(state["result"]["kplMaps"], 2)
            self.assertTrue(any("cannot save success" in line for line in state["logs"]))
            self.assertEqual(read(self.runtime / "job.json")["status"], "running")
            published = manager.data_dir()
            manager.close()
            # Recovery remains correct even while status writes are still failing.
            restarted = self.manager()
            self.assertEqual(restarted.status()["status"], "succeeded")
            self.assertEqual(restarted.data_dir(), published)
            restarted.close()
        recovered = self.manager()
        self.assertEqual(recovered.status()["status"], "succeeded")
        self.assertEqual(read(self.runtime / "job.json")["status"], "succeeded")
        self.assertEqual(recovered.status()["result"]["kplMaps"], 2)

    def test_post_commit_cleanup_failure_does_not_report_rollback(self):
        manager = self.manager()
        def cleanup_failure():
            raise OSError("cleanup failed")
        manager._prune = cleanup_failure
        manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "succeeded", state)
        self.assertEqual(len(read(manager.data_dir() / "data.json")["rows"]), 2)
        self.assertTrue(any("cleanup failed" in line for line in state["logs"]))

    def test_exception_after_publish_return_uses_commit_record(self):
        manager = self.manager()
        original = manager._publish
        def late_failure(work):
            original(work)
            raise OSError("post-publication housekeeping error")
        manager._publish = late_failure
        manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "succeeded", state)
        self.assertEqual(state["result"]["snapshot"], manager.data_dir().name)

    def test_publication_failure_removes_candidate_result(self):
        manager = self.manager()
        def failure(work):
            raise OSError("pointer disk full")
        manager._publish = failure
        manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertNotIn("result", state)
        self.assertEqual(manager.data_dir(), self.root / "dist")

    def test_cleanup_keeps_start_serialized_until_terminal_status(self):
        manager = self.manager()
        pruning, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def slow_cleanup():
            pruning.set()
            release.wait(timeout=3)
        manager._prune = slow_cleanup
        manager.start("kpl")
        self.assertTrue(pruning.wait(timeout=2))
        self.assertEqual(manager.status()["status"], "running")
        self.assertEqual(manager.data_dir().name, manager.status()["id"])
        with self.assertRaises(UpdateBusyError):
            manager.start("lol")
        release.set()
        self.assertEqual(self.done(manager)["status"], "succeeded")

    def test_work_is_reused_and_only_two_published_generations_retained(self):
        manager = self.manager()
        versions = []
        for index in range(4):
            manager.start("kpl")
            self.assertEqual(self.done(manager)["status"], "succeeded")
            versions.append(manager.data_dir())
            write(self.runtime / "work/cache/preserved.json", {"cached": True})
        self.assertEqual(set((self.runtime / "snapshots").iterdir()), set(versions[-2:]))
        self.assertEqual(read(self.runtime / "work/cache/preserved.json"), {"cached": True})
        self.assertEqual(len(read(manager.data_dir() / "data.json")["rows"]), 5)

    def test_real_subprocess_logs_and_success(self):
        (self.root / "update-data.py").write_text(
            "import json,pathlib\n"
            "print(json.dumps({'processed_matches': 1, 'metadata': {'large': 'not public'}}))\n"
            f"pathlib.Path('dist/data.json').write_text({json.dumps(json.dumps(snapshot([{'game_id': 'kpl-1'}])))})\n")
        manager = self.manager(klass=UpdateManager)
        manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "succeeded", state)
        self.assertTrue(any("processed_matches" in line for line in state["logs"]))
        self.assertFalse(any("not public" in line for line in state["logs"]))

    def test_timeout_kills_collector_and_its_child(self):
        child_code = "import time,pathlib; time.sleep(.7); pathlib.Path('child-survived').write_text('bad')"
        (self.root / "update-data.py").write_text(
            "import subprocess,sys,time\n"
            f"subprocess.Popen([sys.executable, '-c', {child_code!r}])\n"
            "print('collector started', flush=True)\n"
            "time.sleep(20)\n")
        manager = self.manager(klass=UpdateManager, timeout_seconds=0.3)
        manager.start("kpl")
        state = self.done(manager)
        self.assertEqual(state["status"], "failed", state)
        self.assertIn("超过", state["message"])
        time.sleep(0.8)
        self.assertFalse((self.runtime / "work/child-survived").exists())
        self.assertEqual(manager.data_dir(), self.root / "dist")

    def test_close_stops_running_subprocess(self):
        (self.root / "update-data.py").write_text("import time\nprint('running', flush=True)\ntime.sleep(20)\n")
        manager = self.manager(klass=UpdateManager)
        manager.start("kpl")
        limit = time.monotonic() + 2
        while manager._process is None and time.monotonic() < limit:
            time.sleep(0.01)
        self.assertIsNotNone(manager._process)
        manager.close()
        self.assertEqual(manager.status()["status"], "failed")
        self.assertEqual(manager.status()["stage"], "interrupted")
        self.assertFalse(manager._thread.is_alive())

    def test_snapshot_pointer_cannot_escape_runtime(self):
        self.runtime.mkdir()
        write(self.runtime / "current.json", {"snapshot": "../../dist"})
        with self.assertRaisesRegex(ValueError, "指针无效"):
            self.manager()

    def test_unknown_game_and_unsafe_runtime_are_rejected(self):
        manager = self.manager()
        for game in ("../update-data.py", "kpl; touch pwned", "", "worlds", "all"):
            with self.assertRaises(ValueError):
                manager.start(game)
        for directory in (self.root, self.root / "dist", self.root / "dist/runtime"):
            with self.assertRaises(ValueError):
                UpdateManager(self.root, directory)


class ExistingSnapshotTests(unittest.TestCase):
    def test_current_real_kpl_game_ids_validate_without_converting_rows(self):
        current = read(ROOT / "dist/data.json")
        self.assertIn("game_id", current["rows"][0])
        self.assertNotIn("id", current["rows"][0])
        _validate_snapshot(current, current, "KPL", identity_field="game_id")

    def test_current_real_lol_known_gaps_and_drafts_are_accepted(self):
        current = read(ROOT / "dist/lol-data.json")
        self.assertFalse(current["metadata"]["complete"])
        _validate_snapshot(current, current, "LoL", allow_known=True)
        for source in ("tencent", "riot"):
            stage = UpdateManager._source_baseline(current, source)
            stage["metadata"]["complete"] = not stage["metadata"]["missing"]
            _validate_snapshot(stage, stage, source, allow_known=True)
        global_report = current["metadata"]["globalRegions"]
        _validate_metadata(global_report, sum(row["id"].startswith("lol-chaincc-") for row in current["rows"]),
                           global_report, "五赛区", allow_known=True)
        UpdateManager._validate_drafts(current, read(ROOT / "dist/champions.json"))

    def test_known_gap_cannot_expand_or_change_reason(self):
        old = lol_data()
        for mutate in (
            lambda c: c["metadata"]["missing"][-1]["missing_maps"].append(3),
            lambda c: c["metadata"]["missing"][0].update(reason="new failure"),
            lambda c: c["metadata"].update(expected_completed_maps=10),
        ):
            candidate = copy.deepcopy(old)
            mutate(candidate)
            with self.assertRaises(UpdateValidationError):
                _validate_snapshot(candidate, old, "LoL", allow_known=True)


if __name__ == "__main__":
    unittest.main()

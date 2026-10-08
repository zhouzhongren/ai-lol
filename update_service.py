"""Run the fixed collectors in isolation and publish complete data generations.

The checked-in dist directory is never changed. A single manager owns a runtime
directory; HTTP handlers can safely call start/status/data_dir from many threads.
"""

import copy
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid


DATA_FILES = ("data.json", "lol-data.json", "lol-events.json", "champions.json")
SCRIPTS = (
    "update-data.py", "update-lol-events.py", "update-lol-data.py",
    "update-demacia-data.py", "merge-lol-data.py", "enrich-lol-drafts.py",
    "update-global-lol-data.py", "collect-riot-series.py", "map-chaincc-series.py",
)
ACTIVE_STATUSES = {"queued", "running"}
PROGRESS_FIELDS = {
    "processed_matches", "total_matches", "completed_matches", "discovered_series",
    "series_processed", "total", "rows", "maps", "issues", "downloaded", "bytes",
    "expected", "missing", "missing_series", "totalMaps", "verifiedMaps",
    "freshlyVerifiedMaps", "retainedVerifiedMaps", "missingMaps",
    "droppedPreviouslyVerifiedMaps", "complete_series", "unlinked_maps", "teams",
    "fixtures", "error",
}


class UpdateBusyError(RuntimeError):
    """Another update is queued or running."""


class UpdateValidationError(ValueError):
    """A collector output is unsafe to publish, even if it exited successfully."""


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _load(path):
    with Path(path).open(encoding="utf-8") as handle:
        return json.load(handle)


def _atomic_json(path, value):
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        # Cleanup is outside the commit boundary: once os.replace succeeded,
        # inability to remove a nonexistent leftover must not report a failure.
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _issue_key(issue):
    # Deliberately compare the full evidence, including missing map numbers and
    # the error reason. A new failure on a previously missing series is not safe.
    return json.dumps(issue, ensure_ascii=False, sort_keys=True)


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate_metadata(metadata, row_count, previous, label, allow_known=False):
    if not isinstance(metadata, dict) or not isinstance(metadata.get("missing"), list):
        raise UpdateValidationError(f"{label}：缺少完整性报告")
    missing = metadata["missing"]
    actual, expected = metadata.get("actual_completed_maps"), metadata.get("expected_completed_maps")
    if not _integer(actual) or not _integer(expected) or actual != row_count or expected < actual:
        raise UpdateValidationError(f"{label}：报告局数与实际数据不一致")
    if metadata.get("complete") is not (not missing and actual == expected):
        raise UpdateValidationError(f"{label}：完整性标记与缺失报告不一致")
    old_missing = previous.get("missing", []) if allow_known else []
    known = {_issue_key(issue) for issue in old_missing}
    new = [issue for issue in missing if _issue_key(issue) not in known]
    if new:
        detail = _issue_key(new[0])[:350]
        raise UpdateValidationError(f"{label}：发现 {len(new)} 项新增缺失，保留上一版。{detail}")
    old_deficit = max(0, previous.get("expected_completed_maps", 0) - previous.get("actual_completed_maps", 0)) if allow_known else 0
    if expected - actual > old_deficit:
        raise UpdateValidationError(f"{label}：缺局数量增加，保留上一版")
    old_competitions = {str(c.get("id", c.get("league"))): c for c in previous.get("competitions", previous.get("leagues", []))}
    for competition in metadata.get("competitions", metadata.get("leagues", [])):
        actual_maps, expected_maps = competition.get("actual_maps"), competition.get("expected_maps")
        if not _integer(actual_maps) or not _integer(expected_maps):
            raise UpdateValidationError(f"{label}：赛事覆盖报告无效")
        old = old_competitions.get(str(competition.get("id", competition.get("league"))), {}) if allow_known else {}
        if max(0, expected_maps - actual_maps) > max(0, old.get("expected_maps", 0) - old.get("actual_maps", 0)):
            raise UpdateValidationError(f"{label}：{competition.get('name', competition.get('id'))} 出现新增缺局")


def _validate_snapshot(snapshot, previous, label, allow_known=False, identity_field="id"):
    rows = snapshot.get("rows")
    if not isinstance(rows, list) or not rows:
        raise UpdateValidationError(f"{label}：采集结果为空")
    ids = [row.get(identity_field) for row in rows if isinstance(row, dict)]
    if len(ids) != len(rows) or any(not isinstance(value, str) or not value for value in ids) or len(set(ids)) != len(ids):
        raise UpdateValidationError(f"{label}：比赛 ID 为空或重复")
    dropped = {row[identity_field] for row in previous.get("rows", [])} - set(ids)
    if dropped:
        raise UpdateValidationError(f"{label}：候选数据丢失 {len(dropped)} 个已发布比赛 ID，保留上一版")
    _validate_metadata(snapshot.get("metadata"), len(rows), previous.get("metadata", {}), label, allow_known)
    return snapshot


class UpdateManager:
    def __init__(self, root: Path, runtime_dir: Path, timeout_seconds=1800):
        self.root = Path(root).resolve()
        self.runtime_dir = Path(runtime_dir).resolve()
        if self.runtime_dir == self.root or self.runtime_dir == self.root / "dist" or self.root / "dist" in self.runtime_dir.parents:
            raise ValueError("运行数据目录必须独立于源码根目录和 dist")
        if timeout_seconds <= 0:
            raise ValueError("更新超时必须大于 0")
        self.timeout_seconds = timeout_seconds
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self._mutex = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._process = None
        self._committed_job_id = None
        self._job_path = self.runtime_dir / "job.json"
        self._lock_file = (self.runtime_dir / "manager.lock").open("a")
        try:
            fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self._lock_file.close()
            raise RuntimeError("另一个服务进程正在使用此运行数据目录") from None
        try:
            self._job = _load(self._job_path) if self._job_path.exists() else None
            current = self.data_dir()  # Reject corrupt pointers instead of quietly serving stale data.
            if self._job and current.parent == self.runtime_dir / "snapshots" and current.name == self._job.get("id"):
                # The pointer is the commit record. The process may have stopped
                # (or job.json writing failed) immediately after it was replaced.
                if self._job.get("status") != "succeeded":
                    self._finish(status="succeeded", stage="done", finishedAt=_now(),
                                 message="数据已发布；服务重启后已恢复更新完成状态。",
                                 result=self._job.get("result", {"snapshot": current.name}))
            elif self._job and self._job.get("status") in ACTIVE_STATUSES:
                self._finish(status="failed", stage="interrupted", finishedAt=_now(),
                             message="服务在更新完成前停止；未完成的候选数据不会发布，请重新更新。")
        except Exception:
            self._lock_file.close()
            raise

    def status(self):
        with self._mutex:
            return copy.deepcopy(self._job)

    def data_dir(self) -> Path:
        pointer = self.runtime_dir / "current.json"
        if not pointer.exists():
            return self.root / "dist"
        value = _load(pointer).get("snapshot")
        if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
            raise ValueError("当前数据版本指针无效")
        directory = self.runtime_dir / "snapshots" / value
        if not directory.is_dir() or any(not (directory / name).is_file() for name in DATA_FILES):
            raise ValueError("当前数据版本不完整")
        return directory

    def start(self, game):
        if game not in {"kpl", "lol"}:
            raise ValueError("仅支持 kpl 或 lol")
        with self._mutex:
            if self._stop.is_set():
                raise RuntimeError("服务正在停止")
            if self._job and self._job.get("status") in ACTIVE_STATUSES:
                raise UpdateBusyError("已有数据更新任务正在运行")
            self._job = {"id": uuid.uuid4().hex, "game": game, "status": "queued",
                         "stage": "queued", "message": "更新任务已排队", "logs": [],
                         "startedAt": _now(), "finishedAt": None}
            self._committed_job_id = None
            try:
                _atomic_json(self._job_path, self._job)
                self._thread = threading.Thread(target=self._update, args=(game,), daemon=True,
                                                name="data-update")
                self._thread.start()
            except Exception as error:
                self._thread = None
                self._finish(status="failed", stage="queued", finishedAt=_now(),
                             message=f"无法启动更新任务：{error}"[:600])
                raise
            return copy.deepcopy(self._job)

    def close(self):
        self._stop.set()
        with self._mutex:
            process, thread = self._process, self._thread
        if process:
            self._terminate(process)
        if thread and thread is not threading.current_thread():
            thread.join(timeout=10)
        if not thread or not thread.is_alive():
            self._lock_file.close()

    def _set(self, **changes):
        with self._mutex:
            self._job.update(changes)
            _atomic_json(self._job_path, self._job)

    def _finish(self, **changes):
        """Always reach a terminal state in memory, including on a full disk.

        Persisting status is best effort. Publishing is recorded independently
        by current.json, which is checked when the service next starts.
        """
        with self._mutex:
            self._job.update(changes)
            if changes.get("status") == "failed":
                self._job.pop("result", None)
            try:
                _atomic_json(self._job_path, self._job)
            except Exception as error:
                warning = f"任务状态暂未写入磁盘：{error}"[:500]
                self._job["logs"] = (self._job.get("logs", []) + [warning])[-120:]

    def _warning(self, message):
        with self._mutex:
            self._job["logs"] = (self._job.get("logs", []) + [str(message)[:500]])[-120:]

    def _log(self, line):
        line = line.strip()
        if not line:
            return
        # Collector metadata can include thousands of rows/aliases. Keep useful
        # progress and errors, not entire metadata JSON in the public job API.
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                return
            if isinstance(value, dict):
                value = {key: val for key, val in value.items()
                         if key in PROGRESS_FIELDS and isinstance(val, (str, int, float, bool))}
                if not value:
                    return
                line = json.dumps(value, ensure_ascii=False)
        elif line[0] in '{}[],"':
            match = re.match(r'"([^"\n]+)":\s*(.*)', line)
            if not match or match[1] not in PROGRESS_FIELDS or match[2].startswith(("[", "{")):
                return
        with self._mutex:
            self._job["logs"] = (self._job["logs"] + [line[:500]])[-120:]
            _atomic_json(self._job_path, self._job)

    def _check_deadline(self):
        if self._stop.is_set():
            raise RuntimeError("服务正在停止，更新已中断")
        if time.monotonic() >= self._deadline:
            raise TimeoutError(f"更新超过 {self.timeout_seconds:g} 秒，已停止采集并保留上一版")

    @staticmethod
    def _terminate(process):
        # Collectors invoke curl and helper Python scripts; killing only their
        # direct parent would leave downloads writing into the reusable cache.
        def send(sig):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                pass
        send(signal.SIGTERM)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        send(signal.SIGKILL)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass

    def _run_command(self, work, arguments):
        self._check_deadline()
        if arguments[0] not in SCRIPTS:
            raise ValueError("不允许的采集脚本")
        # No shell, no client-provided command/path; run the same interpreter as
        # the server, without buffering so progress is visible during collection.
        with self._mutex:
            self._check_deadline()
            environment = os.environ.copy()
            environment["PYTHONUNBUFFERED"] = "1"
            # Existing collectors use assertions for source-data checks. Their
            # validations must remain active even if the server was launched
            # with a PYTHONOPTIMIZE environment setting.
            environment.pop("PYTHONOPTIMIZE", None)
            process = subprocess.Popen([sys.executable, "-u", *arguments], cwd=work,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       start_new_session=True, env=environment)
            self._process = process
        pending = b""
        truncated = False
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    self._check_deadline()
                    ready = selector.select(timeout=0.2)
                    if ready:
                        block = os.read(process.stdout.fileno(), 8192)
                        if not block:
                            break
                        for fragment in block.splitlines(keepends=True):
                            if not truncated:
                                pending += fragment
                                if len(pending) > 65536:
                                    truncated = True
                                    pending = b""
                            if fragment.endswith(b"\n"):
                                if not truncated:
                                    self._log(pending.decode("utf-8", errors="replace"))
                                pending, truncated = b"", False
                    elif process.poll() is not None:
                        break
            if pending:
                self._log(pending.decode("utf-8", errors="replace"))
            while process.poll() is None:
                self._check_deadline()
                self._stop.wait(0.1)
            if process.returncode:
                raise RuntimeError(f"{arguments[0]} 执行失败（退出码 {process.returncode}），请查看日志")
        finally:
            self._terminate(process)
            process.stdout.close()
            with self._mutex:
                self._process = None

    def _stage(self, work, stage, message, arguments, outputs=()):
        self._check_deadline()
        self._set(stage=stage, message=message)
        self._log(message)
        before = {name: (work / name).stat().st_mtime_ns if (work / name).exists() else None for name in outputs}
        self._run_command(work, arguments)
        for name in outputs:
            path = work / name
            if not path.is_file() or path.stat().st_mtime_ns == before[name]:
                raise UpdateValidationError(f"{stage}：脚本未生成新的 {name}，保留上一版")

    def _prepare(self, previous):
        work = self.runtime_dir / "work"
        work.mkdir(exist_ok=True)
        # Exactly one work tree is reused. Preserve collector caches but refresh
        # all code/facts and reset candidates from the currently published data.
        for path in work.iterdir():
            if path.name != "cache":
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                else:
                    path.unlink()
        for name in SCRIPTS:
            shutil.copy2(self.root / name, work / name)
        shutil.copytree(self.root / "data-sources", work / "data-sources")
        shutil.copy2(self.root / "demacia-gol-facts.json", work / "demacia-gol-facts.json")
        (work / "dist").mkdir()
        for name in DATA_FILES:
            shutil.copy2(previous / name, work / "dist" / name)
        # A failed/zero-output script must never accidentally reuse its previous
        # successful candidate or verification report from the shared cache.
        for relative in (
            "lol/tencent-data.json", "lol/demacia-data.json", "lol/base-candidate.json",
            "lol/base-enriched.json", "lol/base-champions.json", "lol/draft-coverage.json",
            "global-lol/coverage-report.json", "global-lol/integration-report.json",
        ):
            (work / "cache" / relative).unlink(missing_ok=True)
        return work

    @staticmethod
    def _source_baseline(previous, source):
        meta = previous["metadata"]
        base = copy.deepcopy(meta.get("globalBaseMetadata", meta))
        demacia = base.get("demacia", meta.get("demacia", {}))
        if source == "riot":
            metadata = demacia
        else:
            metadata = base
            demacia_issues = {_issue_key(issue) for issue in demacia.get("missing", [])}
            metadata["missing"] = [issue for issue in base.get("missing", []) if _issue_key(issue) not in demacia_issues]
            metadata["expected_completed_maps"] = base.get("expected_completed_maps", 0) - demacia.get("expected_completed_maps", 0)
            metadata["actual_completed_maps"] = base.get("actual_completed_maps", 0) - demacia.get("actual_completed_maps", 0)
            metadata["competitions"] = [c for c in base.get("competitions", []) if c.get("id") != "117126995932274206"]
        return {"rows": [row for row in previous["rows"] if row["id"].startswith(f"lol-{source}-")],
                "metadata": metadata}

    def _update_kpl(self, work, previous):
        (work / "dist/data.json").unlink()
        self._stage(work, "kpl", "正在采集 KPL 官方数据", ["update-data.py", "--year", "2026", "--output", "dist/data.json"], ["dist/data.json"])
        candidate = _load(work / "dist/data.json")
        _validate_snapshot(candidate, previous, "KPL", identity_field="game_id")

    def _validate_events(self, candidate, previous):
        if not isinstance(candidate.get("fixtures"), list) or not isinstance(candidate.get("tournaments"), list):
            raise UpdateValidationError("LoL 赛程格式无效")
        for key in ("worlds", "demacia"):
            coverage = candidate.get("coverage", {}).get(key, {})
            old = previous.get("coverage", {}).get(key, {})
            observed = coverage.get("observedSeries")
            if not _integer(observed) or observed <= 0 or observed < old.get("observedSeries", 0):
                raise UpdateValidationError(f"LoL {key}：官方赛程读取为空或覆盖减少，保留上一版")
            if old.get("complete") is True and coverage.get("complete") is not True:
                raise UpdateValidationError(f"LoL {key}：原完整赛程变为不完整，保留上一版")

    def _update_lol(self, work, previous, previous_events):
        self._stage(work, "lol-schedule", "正在刷新 LoL 官方赛程", ["update-lol-events.py"], ["dist/lol-events.json"])
        self._validate_events(_load(work / "dist/lol-events.json"), previous_events)
        self._stage(work, "lol-tencent", "正在采集腾讯 LoL 逐局统计", ["update-lol-data.py"], ["cache/lol/tencent-data.json"])
        _validate_snapshot(_load(work / "cache/lol/tencent-data.json"), self._source_baseline(previous, "tencent"), "腾讯 LoL", True)
        self._stage(work, "lol-demacia", "正在核验德玛西亚杯比赛与时长事实表", ["update-demacia-data.py"], ["cache/lol/demacia-data.json"])
        _validate_snapshot(_load(work / "cache/lol/demacia-data.json"), self._source_baseline(previous, "riot"), "德玛西亚杯", True)
        self._stage(work, "lol-merge", "正在合并已核验的 LoL 官方数据", ["merge-lol-data.py", "--output", "cache/lol/base-candidate.json"], ["cache/lol/base-candidate.json"])
        self._stage(work, "lol-drafts", "正在核验 LoL 英雄阵容", ["enrich-lol-drafts.py", "--base-only", "--input", "cache/lol/base-candidate.json", "--output", "cache/lol/base-enriched.json", "--previous", "dist/lol-data.json", "--catalog-output", "cache/lol/base-champions.json"], ["cache/lol/base-enriched.json", "cache/lol/base-champions.json", "cache/lol/draft-coverage.json"])
        report = _load(work / "cache/lol/draft-coverage.json")
        enriched = _load(work / "cache/lol/base-enriched.json")
        if (report.get("complete") is not True or report.get("outputWritten") is not True
                or report.get("missingMaps") != 0 or report.get("droppedPreviouslyVerifiedMaps") != 0
                or report.get("verifiedMaps") != len(enriched.get("rows", []))):
            raise UpdateValidationError("LoL 英雄阵容报告未通过，保留上一版")
        self._stage(work, "lol-global", "正在下载五赛区数据并核对 Riot 官方系列赛", ["update-global-lol-data.py", "--fetch", "--base", "cache/lol/base-enriched.json"], ["dist/lol-data.json", "dist/champions.json", "cache/global-lol/coverage-report.json", "cache/global-lol/integration-report.json"])
        candidate = _validate_snapshot(_load(work / "dist/lol-data.json"), previous, "LoL 最终数据", True)
        global_report = _load(work / "cache/global-lol/coverage-report.json")
        if global_report != candidate["metadata"].get("globalRegions"):
            raise UpdateValidationError("LoL 五赛区报告与最终数据的来源记录不一致")
        global_count = sum(row["id"].startswith("lol-chaincc-") for row in candidate["rows"])
        _validate_metadata(global_report, global_count, previous["metadata"].get("globalRegions", {}), "LoL 五赛区覆盖报告", True)
        if global_report.get("normalizationIssues") != []:
            raise UpdateValidationError("LoL 五赛区来源校验失败")
        summary = _load(work / "cache/global-lol/integration-report.json")
        if summary.get("maps") != len(candidate["rows"]):
            raise UpdateValidationError("LoL 合并报告与候选数据不一致")
        self._validate_drafts(candidate, _load(work / "dist/champions.json"))

    @staticmethod
    def _validate_drafts(candidate, catalog):
        champions = catalog.get("champions", [])
        ids = [champion.get("id") for champion in champions]
        if not ids or len(set(ids)) != len(ids) or any(not isinstance(value, str) or not value for value in ids):
            raise UpdateValidationError("LoL 英雄目录为空或包含重复 ID")
        coverage = candidate["metadata"].get("draftCoverage", {})
        if coverage.get("complete") is not True or coverage.get("verifiedMaps") != len(candidate["rows"]):
            raise UpdateValidationError("LoL 最终英雄阵容覆盖不足")
        allowed, roles = set(ids), {"top", "jungle", "mid", "bottom", "support"}
        for row in candidate["rows"]:
            lineups = [row.get("lineup_a", {}), row.get("lineup_b", {})]
            if (row.get("draft_verified") is not True or any(set(lineup) != roles for lineup in lineups)
                    or any(not set(lineup.values()) <= allowed for lineup in lineups)
                    or len(set(lineups[0].values()) | set(lineups[1].values())) != 10):
                raise UpdateValidationError(f"LoL {row['id']}：英雄阵容未通过校验")

    def _publish(self, work):
        self._check_deadline()
        snapshots = self.runtime_dir / "snapshots"
        snapshots.mkdir(exist_ok=True)
        snapshot_id = self._job["id"]
        destination = snapshots / snapshot_id
        temporary = snapshots / (snapshot_id + ".tmp")
        temporary.mkdir()
        try:
            for name in DATA_FILES:
                # Parse all four files before making the new generation visible.
                _load(work / "dist" / name)
                shutil.copy2(work / "dist" / name, temporary / name)
            self._check_deadline()
            os.replace(temporary, destination)
            _atomic_json(self.runtime_dir / "current.json", {"snapshot": snapshot_id, "publishedAt": _now()})
            self._committed_job_id = snapshot_id
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
        return destination

    def _prune(self):
        snapshots = self.runtime_dir / "snapshots"
        current = self.data_dir()
        versions = sorted((path for path in snapshots.iterdir() if path.is_dir() and re.fullmatch(r"[a-f0-9]{32}", path.name)),
                          key=lambda path: path.stat().st_mtime_ns, reverse=True)
        keep = set(versions[:2]) | {current}
        for path in versions:
            if path not in keep:
                shutil.rmtree(path)
        for path in snapshots.glob("*.tmp"):
            if path.is_dir() and re.fullmatch(r"[a-f0-9]{32}\.tmp", path.name):
                shutil.rmtree(path)

    def _update(self, game):
        self._deadline = time.monotonic() + self.timeout_seconds
        result = None
        try:
            self._set(status="running", stage="prepare", message="正在创建隔离采集目录")
            previous_dir = self.data_dir()
            previous = {name: _load(previous_dir / name) for name in DATA_FILES}
            work = self._prepare(previous_dir)
            if game == "kpl":
                self._update_kpl(work, previous["data.json"])
            if game == "lol":
                self._update_lol(work, previous["lol-data.json"], previous["lol-events.json"])
            # Everything needed for the result is read and persisted before the
            # pointer changes. No post-commit read failure can undo publication.
            result = {"snapshot": self._job["id"],
                      "kplMaps": len(_load(work / "dist/data.json")["rows"]),
                      "lolMaps": len(_load(work / "dist/lol-data.json")["rows"])}
            self._set(stage="publish", message="校验通过，正在发布新数据", result=result)
            self._publish(work)
        except Exception as error:
            self._warning(error)
            if self._committed_job_id != self._job["id"]:
                self._finish(status="failed", stage="interrupted" if self._stop.is_set() else self._job["stage"],
                             finishedAt=_now(), message=str(error)[:600])
                return
        # Committed data is successful even if housekeeping or job.json fails.
        # Keep status running until housekeeping ends to serialize work reuse.
        try:
            self._prune()
        except Exception as error:
            self._warning(f"新数据已发布，旧快照清理暂未完成：{error}")
        self._finish(status="succeeded", stage="done", finishedAt=_now(),
                     message="数据更新完成，新快照已发布", result=result)

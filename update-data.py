#!/usr/bin/env python3
"""Read the public, credential-free endpoints used by Tencent's match-data website.

API routes and field semantics are published by the site's own JavaScript:
https://pvp.qq.com/m/matchdata/js/league.js
No account, cookies, tokens, private APIs, or fabricated rows are used.
Python 3.9+, standard library only. Completed requests are cached to permit resume.
"""
import argparse
import concurrent.futures
import datetime as dt
import json
import pathlib
import ssl
import threading
import time
import urllib.parse
import urllib.request

BASE = "https://prod.comp.smoba.qq.com/leaguesite"
TZ = dt.timezone(dt.timedelta(hours=8))
ROOT = pathlib.Path(__file__).resolve().parent
LOCK = threading.Lock()
# Some macOS Python distributions do not initialize a CA bundle. Use the OS
# trusted CA bundle when available; certificate and hostname verification stay on.
TLS_CONTEXT = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if pathlib.Path("/etc/ssl/cert.pem").exists() else None)


def fetch(route, params=None, use_cache=True):
    params = params or {}
    key = route.replace("/", "_") + "_" + "_".join(str(v) for v in params.values())
    path = ROOT / "cache" / (key + ".json")
    if use_cache and path.exists():
        return json.loads(path.read_text())
    url = BASE + "/" + route + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "KPL-Research-Local/1.0", "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=25, context=TLS_CONTEXT) as response:
                data = json.load(response)
            if int(data.get("code", 0)) != 200:
                raise ValueError("Source returned code " + str(data.get("code")))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(data, ensure_ascii=False))
            time.sleep(0.12)
            return data
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def as_time(value):
    return dt.datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ)


def iso_time(value):
    return as_time(value).isoformat()


def source_url(league, match):
    return "https://pvp.qq.com/matchdata/scheduleDetails.html?" + urllib.parse.urlencode({"league_id": league, "match_id": match})


def match_row(match, league):
    return {
        "match_id": str(match["match_id"]), "date": iso_time(match["start_time"]),
        "season": league["league_name"], "stage": match.get("match_stage_desc", ""),
        "team_a": match["camp1"]["team_name"], "team_b": match["camp2"]["team_name"],
        "team_a_id": str(match["camp1"]["team_id"]), "team_b_id": str(match["camp2"]["team_id"]),
        "bo": int(match["bo"]), "league_id": str(league["league_id"]),
        "source_url": source_url(league["league_id"], match["match_id"]),
    }


def get_match(item):
    match, league = item
    rows, errors = [], []
    expected = int(match["camp1"]["score"]) + int(match["camp2"]["score"])
    context = match_row(match, league)
    # Conservative publication time: no map is available to the model until
    # the entire series has actually ended, including overlapping schedules.
    context["available_at"] = iso_time(match["end_time"])
    try:
        battles = fetch("match/battles/open", {"match_id": match["match_id"]})["results"]
        for battle in battles:
            if int(battle["status"]) != 2:
                continue
            bid = str(battle["battle_id"])
            try:
                data = fetch("battle/open", {"battle_id": bid})["data"]
                if int(data["status"]) != 2:
                    raise ValueError("battle not completed")
                camps = {str(data[k]["team_id"]): (k, data[k]) for k in ("camp1", "camp2")}
                if len(camps) != 2:
                    raise ValueError("duplicate team identifiers")
                side_a, a = camps[context["team_a_id"]]
                side_b, b = camps[context["team_b_id"]]
                duration = float(data["game_duration"]) / 1000
                ka, kb = int(a["kill_num"]), int(b["kill_num"])
                if not (0 < duration < 7200) or min(ka, kb) < 0:
                    raise ValueError("invalid duration or kills")
                winner_id = str(data["camp" + str(data["win_camp"])]["team_id"])
                if winner_id not in camps:
                    raise ValueError("unknown winner")
                players = data.get("battle_player_list", [])
                for tid, camp in ((context["team_a_id"], a), (context["team_b_id"], b)):
                    team_players = [p for p in players if str(p.get("team_id")) == tid]
                    if len(team_players) != 5:
                        raise ValueError("expected five player rows for " + tid)
                    if sum(int(p["kill_num"]) for p in team_players) != int(camp["kill_num"]):
                        raise ValueError("team kills disagree with player kills")
                row = {**context,
                    "game_id": bid, "game_no": int(data["battle_seq"]),
                    "duration_seconds": duration, "kills_a": ka, "kills_b": kb,
                    "winner": context["team_a"] if winner_id == context["team_a_id"] else context["team_b"],
                    "team_a_side": "blue" if side_a == "camp1" else "red",
                    "team_b_side": "blue" if side_b == "camp1" else "red",
                    "data_url": BASE + "/battle/open?battle_id=" + urllib.parse.quote(bid),
                }
                rows.append(row)
            except Exception as error:
                errors.append({"match_id": match["match_id"], "game_id": bid, "reason": str(error)})
    except Exception as error:
        errors.append({"match_id": match["match_id"], "reason": str(error)})
    rows.sort(key=lambda r: r["game_no"])
    if len(rows) != expected:
        errors.append({"match_id": match["match_id"], "expected_maps": expected, "actual_maps": len(rows), "reason": "map count mismatch"})
    elif sum(r["winner"] == context["team_a"] for r in rows) != int(match["camp1"]["score"]):
        errors.append({"match_id": match["match_id"], "reason": "series score disagrees with map winners"})
    return rows, errors, expected


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--cutoff", default=None, help="ISO datetime; default current time in Asia/Shanghai")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--output", default=str(ROOT / "data.json"))
    args = parser.parse_args()
    now = dt.datetime.now(TZ)
    cutoff = dt.datetime.fromisoformat(args.cutoff) if args.cutoff else now
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=TZ)
    leagues = [l for l in fetch("leagues/open", use_cache=False)["results"] if int(l["year"]) == args.year and l["league_type_name"] == "kpl"]
    fixtures, tasks, totals, missing = [], [], [], []
    for league in leagues:
        matches = fetch("matches/open", {"league_id": league["league_id"]}, use_cache=False)["results"]
        complete = [m for m in matches if int(m["status"]) == 2 and as_time(m["end_time"]) <= cutoff and as_time(m["start_time"]).year == args.year]
        future = [m for m in matches if int(m["status"]) == 0 and as_time(m["start_time"]) > cutoff]
        tasks.extend((m, league) for m in complete)
        fixtures.extend(match_row(m, league) for m in future)
        totals.append({"id": league["league_id"], "name": league["league_name"], "completed_matches": len(complete), "expected_maps": sum(int(m["camp1"]["score"])+int(m["camp2"]["score"]) for m in complete), "upcoming_matches": len(future)})
    print(json.dumps({"leagues": totals, "completed_matches": len(tasks)}, ensure_ascii=False), flush=True)
    rows, expected = [], 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, args.workers))) as pool:
        for i, result in enumerate(pool.map(get_match, tasks), 1):
            r, e, n = result
            rows.extend(r)
            missing.extend(e)
            expected += n
            if i % 20 == 0 or i == len(tasks):
                print(json.dumps({"processed_matches": i, "total_matches": len(tasks), "maps": len(rows), "issues": len(missing)}, ensure_ascii=False), flush=True)
    rows.sort(key=lambda r: (r["date"], r["match_id"], r["game_no"]))
    fixtures.sort(key=lambda r: r["date"])
    keys = [r["game_id"] for r in rows]
    if len(set(keys)) != len(keys):
        missing.append({"reason": "duplicate game_id in source"})
    for league in totals:
        league["actual_maps"] = sum(r["league_id"] == league["id"] for r in rows)
    output = {
        "metadata": {
            "year": args.year, "fetchedAt": dt.datetime.now(TZ).isoformat(), "cutoff": cutoff.isoformat(),
            "source": "腾讯王者荣耀官方赛事数据平台", "source_url": "https://pvp.qq.com/matchdata/index.html",
            "source_script": "https://pvp.qq.com/m/matchdata/js/league.js",
            "source_api": BASE, "leagues": totals, "completed_matches": len(tasks),
            "expected_completed_maps": expected, "actual_completed_maps": len(rows), "missing": missing,
            "complete": not missing and expected == len(rows),
            "scope": "官方平台 year=2026、league_type_name=kpl 的赛事，包括挑战者杯；仅截至 cutoff 已结束比赛、已结束对局。",
            "checks": ["series camp order reconciled by team_id", "duration source milliseconds converted to seconds", "team kills checked against five player rows", "map winners checked against series score", "map counts checked against completed series score", "map availability set to official series end_time"],
            "limitations": ["公开网站数据接口，无公开服务稳定性承诺，字段和路径可能变化。", "官网未提供盘口，时间大小、击杀大小、让击杀阈值需用户输入。", "历史数据不包含已核验的游戏版本字段。"],
        }, "rows": rows, "fixtures": fixtures,
    }
    path = pathlib.Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    tmp.replace(path)
    print(json.dumps({"output": str(path), **output["metadata"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

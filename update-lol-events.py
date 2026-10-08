#!/usr/bin/env python3
"""Refresh public Riot schedule HTML; no login, private API, or guessed matchups.

The site embeds public Apollo event records in server-rendered HTML. Each page
is a pagination window, so coverage is explicitly reported rather than assumed.
Existing tournament announcements and manually verified region labels are kept.
"""

import argparse
import datetime as dt
import hashlib
import json
import re
import ssl
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TZ = dt.timezone(dt.timedelta(hours=8))
SOURCES = {
    "worlds": "https://lolesports.com/en-US/leagues/worlds",
    "demacia": "https://lolesports.com/en-US/leagues/demacia_cup",
}
SLUGS = {"worlds": "worlds", "demacia": "demacia_cup"}
EXPECTED_SERIES = {"worlds": 46, "demacia": 27}


def extract_events(html):
    decoder = json.JSONDecoder()
    events = {}
    for match in re.finditer(r'\{"__typename":"EventMatch"', html):
        try:
            event, _ = decoder.raw_decode(html[match.start():])
            events[event["id"]] = event
        except (ValueError, KeyError):
            continue
    return list(events.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Parse saved HTML snapshots")
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "lol-events.json",
                        help="Existing event JSON to update; defaults to dist/lol-events.json")
    args = parser.parse_args()
    metadata_path = args.output if args.output.exists() else ROOT / "dist" / "lol-events.json"
    output = json.loads(metadata_path.read_text())
    fixtures = []
    now = dt.datetime.now(TZ)
    output["parsedAt"] = now.isoformat()
    if not args.offline:
        output["fetchedAt"] = now.isoformat()
        output["asOf"] = now.date().isoformat()
    output["sourceSnapshots"] = []
    for key, source in SOURCES.items():
        cache=ROOT / "cache" / "lol-schedule"
        cache.mkdir(parents=True,exist_ok=True)
        path = cache / f"{key}-schedule.html"
        if not args.offline:
            request = urllib.request.Request(source, headers={"User-Agent": "Mozilla/5.0"})
            context = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if Path("/etc/ssl/cert.pem").exists() else None)
            with urllib.request.urlopen(request, context=context, timeout=60) as response:
                html = response.read().decode("utf-8")
            path.write_text(html)
        else:
            html = path.read_text()
        all_events = extract_events(html)
        events = [e for e in all_events if e["league"]["slug"] == SLUGS[key]
                  and e["startTime"].startswith("2026-")]
        if not events:
            raise ValueError(f"No 2026 {key} events in public HTML; refusing to erase data")
        (cache / f"{key}-events.json").write_text(json.dumps(all_events, ensure_ascii=False, indent=2))
        upcoming = [e for e in events if e["state"] == "unstarted"]
        completed = [e for e in events if e["state"] == "completed"]
        tournament = next(t for t in output["tournaments"] if t["id"] == key)
        confirmed = 0
        for event in upcoming:
            teams = [None if t["code"] == "TBD" else t["code"] for t in event["matchTeams"]]
            if len(teams) != 2:
                raise ValueError(f"Unexpected team count: {event['id']}")
            pending = any(t is None for t in teams)
            confirmed += int(not pending)
            fixtures.append({
                "id": event["id"], "game": "lol", "tournament": key,
                "event": tournament["name"] + " · " + event["blockName"],
                "date": dt.datetime.fromisoformat(event["startTime"].replace("Z", "+00:00")).astimezone(TZ).isoformat(),
                "teamA": teams[0], "teamB": teams[1],
                "bo": event["match"]["strategy"]["count"], "pending": pending,
                "stage": event["blockName"], "source_url": source,
            })
        complete = len(events) == EXPECTED_SERIES[key]
        tournament.update({"schedule_url": source, "scheduleComplete": complete,
                           "confirmedPairings": confirmed,
                           "official_league_id": events[0]["league"]["id"],
                           "official_tournament_id": events[0]["tournament"]["id"]})
        announcement = ("北京时间10月16日开赛，11月15日决赛。" if key == "worlds" else
                        "10月3—8日瑞士轮，10月12—15日淘汰赛，10月17日决赛。")
        tournament["notice"] = (announcement + f"当前官方公开赛程读取到{len(upcoming)}场未开始，"
                                 f"其中{confirmed}场对阵已确认；未抽签配对保持待定。" +
                                 ("赛事赛程已完整收录。" if complete else "当前为分页窗口，赛程未完整收录。"))
        names = {t["code"]: t["name"] for e in events for t in e["matchTeams"] if t["code"] != "TBD"}
        for team in tournament["teams"]:
            if team["code"] in names:
                team["name"] = names[team["code"]]
                team["source_url"] = source
        output["coverage"][key] = {
            "fetchedScheduleSlots": len(upcoming), "completedSeries": len(completed),
            "confirmedPairings": confirmed, "complete": complete,
            "expectedSeriesByAnnouncedFormat": EXPECTED_SERIES[key],
            "observedSeries": len(events),
            "note": "官方HTML分页窗口，未抽签对阵保持空值；逐局统计由独立采集器核验。",
        }
        output["sourceSnapshots"].append({"source_url": source, "path": path.name,
                                          "sha256": hashlib.sha256(html.encode()).hexdigest(),
                                          "parsedEventCount": len(events)})
    output["fixtures"] = sorted(fixtures, key=lambda e: (e["date"], e["id"]))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"fixtures": len(fixtures), "coverage": output["coverage"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

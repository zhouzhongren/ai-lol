#!/usr/bin/env python3
"""Collect only public statistics displayed by Tencent's official LoL website.

The official site's shared browser application Authorization header is obtained
from its public JavaScript, never from a user's account. No login, cookies, or
private credentials are used. The application value is never saved in outputs.
"""
import argparse
import concurrent.futures
import datetime as dt
import json
import pathlib
import re
import ssl
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / 'cache' / 'lol'
TLS = ssl.create_default_context(cafile='/etc/ssl/cert.pem' if pathlib.Path('/etc/ssl/cert.pem').exists() else None)
BASE = 'https://open.tjstats.com/match-auth-app/open/v1'
TZ = dt.timezone(dt.timedelta(hours=8))
TARGETS = {'237': 'LPL', '238': 'First Stand', '239': 'MSI', '241': 'EWC', '245': 'Demacia Cup'}
TEAM_ALIASES = {
    'Anyone’s Legend':'AL', "Anyone's Legend":'AL', 'Bilibili Gaming':'BLG',
    'TOP Esports':'TES', 'Top Esports':'TES', 'Shanghai Invictus Gaming Meituan':'IG',
    'Invictus Gaming':'IG', 'Gen.G':'GEN', 'Hanwha Life Esports':'HLE', 'T1':'T1',
    'Dplus Kia':'DK', 'G2 Esports':'G2', 'Movistar KOI':'MKOI', 'Karmine Corp':'KC',
    'Team Liquid Alienware':'TLAW', 'LYON':'LYON', 'Cloud9 Kia':'C9',
    'Team Secret Whales':'TSW', 'CTBC Flying Oyster':'CFO', 'MVK Esports':'MVK',
    'LOS':'LOS', 'FURIA':'FUR',
}


def load_json_script(raw):
    source = raw.decode('utf-8-sig')
    return json.loads(source[source.find('{'):source.rfind('}')+1])


def http(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {'Accept': 'application/json'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=22, context=TLS) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(0.5 * (attempt + 1))


def collect(output_path):
    now = dt.datetime.now(TZ)
    CACHE.mkdir(parents=True,exist_ok=True)
    public_script_url = 'https://lpl.qq.com/web202301/js/common.js'
    script = http(public_script_url).decode('gb18030', errors='replace')
    public_application_header = re.search(r"Authorization:\s*'([^']+)'", script).group(1)
    headers = {'Authorization': public_application_header, 'Accept': 'application/json',
               'Origin': 'https://lpl.qq.com', 'Referer': 'https://lpl.qq.com/'}
    list_url = 'https://lpl.qq.com/web201612/data/LOL_MATCH2_MATCH_HOMEPAGE_BMATCH_LIST.js'
    raw_list = http(list_url)
    (CACHE/'schedule-source.js').write_bytes(raw_list)
    listed = load_json_script(raw_list)['msg']
    matches = [m for m in listed if m['GameId'] in TARGETS and m['MatchDate'].startswith('2026-')
               and m['MatchStatus'] == '3' and dt.datetime.fromisoformat(m['MatchDate']).replace(tzinfo=TZ) <= now]
    print(json.dumps({'discovered_series':len(matches), 'competitions':sorted(set(m['GameName'] for m in matches))},ensure_ascii=False), flush=True)

    def get_match(match):
        mid = str(match['bMatchId'])
        rows, missing = [], []
        url = BASE + '/compound/matchDetail?matchId=' + mid
        path = CACHE/(mid+'.json')
        try:
            data = json.loads(path.read_text()) if path.exists() else json.loads(http(url, headers))
            if data.get('success') is not True or not data.get('data'):
                raise ValueError('official statistics unavailable: '+str(data.get('errMsg','empty response')))
            if not path.exists():
                path.write_text(json.dumps(data,ensure_ascii=False))
                time.sleep(.08)
            info=data['data']
            if int(info['matchStatus']) != 2:
                raise ValueError('series not completed according to statistics endpoint')
            if str(info['seasonId']) != match['GameId'] or str(info['matchId']) != mid:
                raise ValueError('series identifiers disagree')
            team_a,team_b=str(info['teamAId']),str(info['teamBId'])
            if team_a == team_b:
                raise ValueError('duplicate team id')
            games=info.get('matchInfos') or []
            expected=int(info['teamAScore'])+int(info['teamBScore'])
            completed=[g for g in games if int(g.get('matchStatus',-1)) == 2]
            if len(completed) != expected:
                raise ValueError(f'completed game count {len(completed)} differs from score {expected}')
            end_times=[dt.datetime.fromisoformat(g['matchEndTime']) for g in completed]
            if not end_times:
                raise ValueError('missing actual end timestamp')
            available=max(end_times)
            series_start=min(dt.datetime.fromisoformat(g['matchStartTime']) for g in completed)
            if available > now:
                raise ValueError('end time after collection cutoff')
            for game in completed:
                seq=int(game['bo'])
                try:
                    duration=int(game['gameTime'])
                    if not 0 < duration < 10800:
                        raise ValueError('invalid game duration')
                    start=dt.datetime.fromisoformat(game['matchStartTime'])
                    end=dt.datetime.fromisoformat(game['matchEndTime'])
                    if end < start or available < end:
                        raise ValueError('invalid actual timestamps')
                    teams={str(t['teamId']):t for t in game['teamInfos']}
                    a,b=teams[team_a],teams[team_b]
                    for team in (a,b):
                        players=team.get('playerInfos') or []
                        if len(players) != 5 or sum(int(p['battleDetail']['kills']) for p in players) != int(team['kills']):
                            raise ValueError('team kills disagree with five player kills')
                    ka,kb=int(a['kills']),int(b['kills'])
                    if min(ka,kb) < 0:
                        raise ValueError('negative kills')
                    winner=str(game['matchWin'])
                    if winner not in (team_a,team_b):
                        raise ValueError('unknown map winner')
                    rows.append({
                        'id':f'lol-tencent-{mid}-{seq}', 'series_id':f'lol-tencent-{mid}',
                        'date':series_start.isoformat(), 'scheduled_at':info['matchTime'], 'available_at':available.isoformat(),
                        'actual_start':game['matchStartTime'], 'actual_end':game['matchEndTime'],
                        'season':'2026', 'event':match['GameName']+' · '+match['GameTypeName'],
                        'patch':'', 'team_a':info['teamAName'], 'team_b':info['teamBName'],
                        'team_a_id':'tencent-lol:'+team_a, 'team_b_id':'tencent-lol:'+team_b,
                        'map':seq,'duration_sec':duration,'kills_a':ka,'kills_b':kb,
                        'winner':info['teamAName'] if winner == team_a else info['teamBName'],
                        'bo':int(info['gameMode'].replace('BO','')), 'game':'lol',
                        'league':TARGETS[match['GameId']], 'league_id':match['GameId'],
                        'tournament':{'237':'lpl','238':'firststand','239':'msi','241':'ewc','245':'demacia'}[match['GameId']],
                        'match_id':mid,'synthetic':False,'verified':True,
                        'source_url':'https://lpl.qq.com/web202301/stats.shtml?bmid='+mid,
                        'data_url':url,
                    })
                except Exception as error:
                    missing.append({'match_id':mid,'map':seq,'reason':str(error)})
            if len(rows)!=expected:
                missing.append({'match_id':mid,'expected_maps':expected,'actual_maps':len(rows),'reason':'missing or invalid games'})
            if sum(r['winner']==info['teamAName'] for r in rows)!=int(info['teamAScore']):
                missing.append({'match_id':mid,'reason':'map winners disagree with series score'})
        except Exception as error:
            missing.append({'match_id':mid,'reason':str(error)})
        return rows,missing

    rows,missing=[],[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for index,(r,e) in enumerate(pool.map(get_match,matches),1):
            rows.extend(r);missing.extend(e)
            if index%20==0 or index==len(matches):
                print(json.dumps({'series_processed':index,'total':len(matches),'rows':len(rows),'issues':len(missing)}),flush=True)
    rows.sort(key=lambda r:(r['date'],r['series_id'],r['map']))
    assert len(set(r['id'] for r in rows)) == len(rows)
    coverage=[]
    for lid,name in TARGETS.items():
        ms=[m for m in matches if m['GameId']==lid]
        coverage.append({'id':lid,'name':name,'listed_completed_matches':len(ms),
                         'expected_maps':sum(int(m['ScoreA'])+int(m['ScoreB']) for m in ms),
                         'actual_maps':sum(r['league_id']==lid for r in rows)})
    team_coverage=[]
    for team in sorted({r[k] for r in rows for k in ('team_a','team_b')}):
        games=[r for r in rows if team in (r['team_a'],r['team_b'])]
        ids={r['team_a_id'] if team==r['team_a'] else r['team_b_id'] for r in games}
        team_coverage.append({'team':team,'team_ids':sorted(ids),'maps':len(games),
                              'series':len({r['series_id'] for r in games}),
                              'latestDate':max(r['date'] for r in games),
                              'tournaments':sorted({r['tournament'] for r in games})})
    output={'rows':rows,'fixtures':[],'metadata':{
        'game':'lol','year':2026,'source':'腾讯英雄联盟官方赛事数据平台',
        'source_url':'https://lpl.qq.com/','source_api':BASE,'source_script':public_script_url,
        'cutoff':now.isoformat(),'fetchedAt':dt.datetime.now(TZ).isoformat(),
        'competitions':coverage,'teamCoverage':team_coverage,'listed_completed_matches':len(matches),
        'teamAliases':{**TEAM_ALIASES, **{t['team']:t['team'] for t in team_coverage}},
        'teamAliasesSource':'https://lolesports.com/en-SG/news/worlds-2026-primer',
        'completed_matches':len({r['series_id'] for r in rows}),
        'expected_completed_maps':sum(c['expected_maps'] for c in coverage),
        'latestDate':rows[-1]['date'] if rows else None,
        'actual_completed_maps':len(rows),'missing':missing,'complete':not missing,
        'scope':'腾讯官方公开列表收录的2026 LPL、MSI、全球先锋赛与EWC已结束比赛；不代表全球全赛区覆盖。',
        'checks':['team ids reconciled per game','kills verified against five players','winner totals compared with series score','gameTime seconds preserved; actual timestamps not used to invent game duration','all maps available only after last actual map end'],
        'limitations':['2026德玛西亚杯官方旧静态赛程没有提供比赛记录，仍需单独接入。','尚未覆盖所有Worlds参赛队本土联赛。','2026Worlds首轮对阵未公布时不生成确定比赛。','官方页面未提供已核验的版本字段。'],
    }}
    output_path.parent.mkdir(parents=True,exist_ok=True)
    output_path.write_text(json.dumps(output,ensure_ascii=False,indent=2))
    print(json.dumps(output['metadata'],ensure_ascii=False),flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, default=ROOT/"cache"/"lol"/"tencent-data.json")
    args=parser.parse_args()
    collect(args.output)

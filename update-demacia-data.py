#!/usr/bin/env python3
"""Build verified 2026 Demacia data from Riot feeds + reviewed public GOL facts.

Usage: python3 update-demacia-data.py --events demacia-events.json
The duration facts file contains public page facts reviewed on 2026-10-08.
Future games without independently obtained duration facts are reported missing;
wall-clock timestamps are NEVER substituted for in-game duration.
No authentication, cookies, or private credentials are required.
"""
import argparse
import concurrent.futures
import datetime as dt
import json
import pathlib
import ssl
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
CACHE = ROOT / 'cache' / 'lol-riot'
TZ = dt.timezone(dt.timedelta(hours=8))
TLS = ssl.create_default_context(cafile='/etc/ssl/cert.pem' if pathlib.Path('/etc/ssl/cert.pem').exists() else None)
SCHEDULE = 'https://lolesports.com/en-US/leagues/demacia_cup'
FEED = 'https://feed.lolesports.com/livestats/v1/window/'
GOL_ALIASES = {'RED Canids':'RED','Natus Vincere':'NAVI','FlyQuest':'FLY',
 'LGD Gaming':'LGD','KT Rolster':'KT','Shopify Rebellion':'SR','BNK FearX':'BFX',
 'Team Vitality':'VIT','Team WE':'WE','GAM Esports':'GAM','JD Gaming':'JDG','HANJIN BRION':'BRO'}

def parse_time(value):
    return dt.datetime.fromisoformat(value.replace('Z','+00:00'))

def fetch_frames(game_id, scheduled):
    output = {}
    for kind in ('initial','final'):
        path = CACHE / f'{game_id}-{kind}.json'
        url = FEED + game_id
        if kind == 'final':
            # A time after completion returns the archived final window.
            end_query = parse_time(scheduled) + dt.timedelta(hours=12)
            url += '?startingTime=' + urllib.parse.quote(end_query.isoformat(timespec='seconds').replace('+00:00','Z'))
        if not path.exists():
            for attempt in range(3):
                try:
                    request = urllib.request.Request(url,headers={'Accept':'application/json','User-Agent':'Mozilla/5.0'})
                    with urllib.request.urlopen(request,timeout=22,context=TLS) as response:
                        data = json.load(response)
                    assert data.get('frames'), 'No public feed frames'
                    path.write_text(json.dumps(data))
                    break
                except Exception:
                    if attempt == 2: raise
                    time.sleep(0.5 * (attempt+1))
        output[kind] = json.loads(path.read_text())
    return output

def collect(events_path, output_path):
    CACHE.mkdir(parents=True,exist_ok=True)
    events = json.loads(events_path.read_text())
    events = [e for e in events if e['league']['slug']=='demacia_cup' and e['state']=='completed' and e['startTime'].startswith('2026-')]
    facts = json.loads((ROOT/'demacia-gol-facts.json').read_text())
    for fact in facts:
        for team in fact['teams']: team['code'] = GOL_ALIASES[team['name']]
    existing_path = ROOT/'dist'/'lol-data.json'
    base_rows = json.loads(existing_path.read_text())['rows'] if existing_path.exists() else []
    canonical_ids = {}
    for row in base_rows:
        for side in ('a','b'):
            if row.get('team_'+side+'_id','').startswith('tencent-lol:'):
                canonical_ids[row['team_'+side]] = row['team_'+side+'_id']

    def collect_series(event):
        maps = []
        teams = event['matchTeams']
        team_ids = {t['id'].split(':')[-1]:t['code'] for t in teams}
        team_codes = set(team_ids.values())
        try:
            for game in event['match']['games']:
                if game['state'] != 'completed': continue
                matching = [f for f in facts if f['date']==event['startTime'][:10] and f['map']==game['number'] and {t['code'] for t in f['teams']}==team_codes]
                assert len(matching)==1, 'Missing or ambiguous reviewed duration facts'
                fact = matching[0]
                data = fetch_frames(game['id'],event['startTime'])
                first = data['initial']['frames'][0]
                final = data['final']['frames'][-1]
                assert final['gameState']=='finished', 'Feed has not reached finished state'
                assert str(data['final']['esportsMatchId'])==str(event['id'])
                assert str(data['final']['esportsGameId'])==str(game['id'])
                # First frames are initialization snapshots, before any kills.
                assert first['blueTeam']['totalKills']==first['redTeam']['totalKills']==0
                assert first['blueTeam']['totalGold']==first['redTeam']['totalGold']==0
                actual_start = parse_time(first['rfc460Timestamp'])
                actual_end = parse_time(final['rfc460Timestamp'])
                assert actual_start < actual_end <= dt.datetime.now(dt.timezone.utc)
                assert 300 <= fact['duration_sec'] <= 7200
                assert fact['duration_sec'] <= (actual_end-actual_start).total_seconds()+5
                stats = {}
                quality_notes = []
                for side in ('blue','red'):
                    tid = str(data['final']['gameMetadata'][side+'TeamMetadata']['esportsTeamId'])
                    code = team_ids[tid]
                    state = final[side+'Team']
                    assert len(state['participants'])==5
                    player_kills = sum(p['kills'] for p in state['participants'])
                    source_team = next(t for t in fact['teams'] if t['code']==code)
                    assert source_team['kills']==player_kills, 'Riot player kills/GOL kill counts disagree'
                    if player_kills != state['totalKills']:
                        quality_notes.append(f"{code}: Riot totalKills={state['totalKills']}, five-player kills={player_kills}; published GOL kills agree with player sum, so player kills are used.")
                    stats[code] = {'kills':player_kills,'raw_feed_team_kills':state['totalKills'],'id':tid,'side':side}
                winners = [t['code'] for t in fact['teams'] if t['result']=='WIN']
                assert len(winners)==1
                a,b = teams[0]['code'],teams[1]['code']
                maps.append({
                    'id':'lol-riot-'+game['id'],'series_id':'lol-riot-'+event['id'],
                    'date':actual_start.isoformat(),'scheduled_at':event['startTime'],
                    'actual_start':actual_start.isoformat(),'actual_end':actual_end.isoformat(),
                    'available_at':actual_end.isoformat(),'season':'2026','game':'lol',
                    'event':'2026 德玛西亚杯国际邀请赛 · 瑞士轮','tournament':'demacia',
                    'patch':data['final']['gameMetadata']['patchVersion'],
                    'team_a':a,'team_b':b,
                    'team_a_id':canonical_ids.get(a,'riot-lol:'+stats[a]['id']),
                    'team_b_id':canonical_ids.get(b,'riot-lol:'+stats[b]['id']),
                    'riot_team_a_id':stats[a]['id'],'riot_team_b_id':stats[b]['id'],
                    'team_a_side':stats[a]['side'],'team_b_side':stats[b]['side'],
                    'map':game['number'],'duration_sec':fact['duration_sec'],
                    'kills_a':stats[a]['kills'],'kills_b':stats[b]['kills'],'winner':winners[0],
                    'raw_feed_team_kills_a':stats[a]['raw_feed_team_kills'],
                    'raw_feed_team_kills_b':stats[b]['raw_feed_team_kills'],
                    'raw_feed_team_kills':{'team_a':stats[a]['raw_feed_team_kills'],'team_b':stats[b]['raw_feed_team_kills']},
                    'kills_method':'player_sum_cross_checked',
                    'kills_basis':'sum of five Riot participant kills, independently matched to GOL',
                    'data_quality_notes':quality_notes,
                    'bo':event['match']['strategy']['count'],'league':'Demacia Cup',
                    'league_id':event['league']['id'],'match_id':event['id'],
                    'source':'Riot Games 官方击杀 / Games of Legends 时长及单局胜负',
                    'source_url':fact['source_url'],'duration_source_url':fact['source_url'],
                    'kills_source_url':SCHEDULE,'schedule_source_url':SCHEDULE,
                    'data_url':FEED+game['id'],'verified':True,'synthetic':False,
                    'timestamp_basis':'Riot feed initialization and last finished frame',
                })
            assert len(maps)==sum(t['result']['gameWins'] for t in teams)
            for team in teams:
                assert sum(r['winner']==team['code'] for r in maps)==team['result']['gameWins']
            series_start = min(parse_time(r['actual_start']) for r in maps).isoformat()
            series_end = max(parse_time(r['actual_end']) for r in maps).isoformat()
            for row in maps: row['date']=series_start; row['available_at']=series_end
            return maps,[]
        except Exception as error:
            return [],[{'match_id':event['id'],'event':'2026 德玛西亚杯','error':str(error)}]

    rows,missing = [],[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for good,bad in pool.map(collect_series,events): rows.extend(good); missing.extend(bad)
    rows.sort(key=lambda r:(r['date'],r['series_id'],r['map']))
    assert len({r['id'] for r in rows})==len(rows)
    output = {'rows':rows,'fixtures':[],'metadata':{
        'game':'lol','year':2026,'source':'Riot Games 官方比赛数据 + Games of Legends 公开逐局时长',
        'source_url':SCHEDULE,'source_api':FEED,
        'duration_source_url':'https://gol.gg/tournament/tournament-matchlist/Demacia%20Cup%20Global%20Invitational%202026/',
        'fetchedAt':dt.datetime.now(TZ).isoformat(),'cutoff':dt.datetime.now(TZ).isoformat(),
        'latestDate':max((r['date'] for r in rows),default=None),
        'historyAvailableThrough':max((r['available_at'] for r in rows),default=None),
        'listed_completed_matches':len(events),'completed_matches':len({r['series_id'] for r in rows}),
        'expected_completed_maps':sum(t['result']['gameWins'] for e in events for t in e['matchTeams']),
        'actual_completed_maps':len(rows),'missing':missing,'complete':not missing,
        'teamAliases':GOL_ALIASES,
        'checks':['Riot finished frames only','five player kills used, independently matched to GOL kills','raw Riot aggregate kills retained for anomaly review','game winners sum to official series score','game duration from published in-game time, never wall clock','series data available only after last finished frame'],
        'dataQualityNotes':[{'id':r['id'],'notes':r['data_quality_notes']} for r in rows if r['data_quality_notes']],
        'discrepancies':[{'id':r['id'],'reason':'Riot team aggregate differs from participant sum; participant sum agrees with independent GOL published kills.',
                         'accepted':{'team_a':r['kills_a'],'team_b':r['kills_b']},'raw':r['raw_feed_team_kills'],
                         'team_a':r['team_a'],'team_b':r['team_b'],'source_url':r['source_url']} for r in rows if r['data_quality_notes']],
        'limitations':['逐局时长事实表截至2026-10-07；新增比赛须先补充并核验公开时长，脚本不会猜测时长。','Riot时间为赛事实时数据初始化及完成帧时间；结束帧用于保守限制历史数据可用时间。','2局Riot团队击杀聚合值与选手击杀和不一致；采用与GOL逐局统计一致的五名选手击杀和，保留原值及核验说明。'],
    }}
    output_path.parent.mkdir(parents=True,exist_ok=True)
    output_path.write_text(json.dumps(output,ensure_ascii=False,indent=2))
    print(json.dumps(output['metadata'],ensure_ascii=False,indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--events',type=pathlib.Path,default=ROOT/'cache'/'lol-schedule'/'demacia-events.json')
    parser.add_argument('--output',type=pathlib.Path,default=ROOT/'cache'/'lol'/'demacia-data.json')
    args = parser.parse_args()
    collect(args.events,args.output)

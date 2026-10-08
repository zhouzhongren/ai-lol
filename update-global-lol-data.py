#!/usr/bin/env python3
"""Normalize published ChainCC team/player CSVs without inventing series or ends.

Dates use official scheduled starts when linked; otherwise they use a labelled
conservative UTC bound under offsets [-12,+14] hours, not an actual start.
available_at is the verified snapshot observation, never date + game duration.
"""
import argparse
import collections
import copy
import csv
import datetime as dt
import gzip
import hashlib
import json
import pathlib
import re
import os
import subprocess
import sys
import tempfile

ROOT=pathlib.Path(__file__).resolve().parent
SOURCE='https://chaincc.lol/free/data'
METHOD='https://chaincc.lol/about/methodology'
DEFAULT_LEAGUES=('LCK','LEC','LCS','LCP','CBLOL')
ROLES={'top':'top','jng':'jungle','mid':'mid','bot':'bottom','sup':'support'}
REGIONS={'LCK':'Korea','LEC':'EMEA','LCS':'North America','LCP':'Asia Pacific','CBLOL':'Brazil','EWC':'International'}
# Canonical abbreviations already used by the site's official international data.
EXTRA_ALIASES={'Cloud9':'C9','Team Liquid':'TLAW','LØS':'LOS',
               'Deep Cross Gaming':'DCG','BNK FEARX':'BFX'}

def load(path): return json.loads(path.read_text())
def save(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def atomic_save(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,delete=False) as handle:
            temporary=pathlib.Path(handle.name);json.dump(value,handle,ensure_ascii=False,indent=2);handle.write('\n')
        os.replace(temporary,path)
    finally:
        if temporary and temporary.exists():temporary.unlink()

def merge_snapshots(base,supplement,previous=None):
    base_rows=[r for r in base['rows'] if not r['id'].startswith('lol-chaincc-')]
    old_metadata=base['metadata'].get('globalBaseMetadata',base['metadata'])
    metadata=copy.deepcopy(old_metadata)
    rows=copy.deepcopy(base_rows)+copy.deepcopy(supplement['rows'])
    assert len({r['id'] for r in rows})==len(rows), 'Duplicate game IDs in merged snapshot'
    assert not supplement['metadata'].get('normalizationIssues'), 'Source data validation failed; do not publish'
    old_by_id={r['id']:r for r in (previous or {}).get('rows',[])}
    for row in rows:
        old=old_by_id.get(row['id'])
        if row['id'].startswith('lol-chaincc-') and old and old.get('availability_basis')=='observed_snapshot':
            fields=('source_game_id','source_date_raw','team_a','team_b','duration_sec','kills_a','kills_b','winner','patch','lineup_a','lineup_b')
            if all(old.get(key)==row.get(key) for key in fields) and instant(old['observed_at'])<=instant(row['observed_at']):
                row['observed_at']=old['observed_at'];row['available_at']=old['available_at']
    new_ids={r['id'] for r in rows}
    missing_old=set(old_by_id)-new_ids
    assert not missing_old, f'Candidate omits {len(missing_old)} existing game IDs; published snapshot remains unchanged'
    rows.sort(key=lambda r:(instant(r['date']),r['id']))
    gm=supplement['metadata']
    metadata.update({'globalBaseMetadata':copy.deepcopy(old_metadata),'globalRegions':copy.deepcopy(gm),
        'source':'腾讯 / Riot Games / Games of Legends / ChainCC 公开赛事数据',
        'sources':list(old_metadata.get('sources',[]))+[{'name':'ChainCC 2026 五大赛区公开比赛数据','url':SOURCE,
            'license':'CC BY 4.0','license_url':'https://creativecommons.org/licenses/by/4.0/',
            'maps':len(supplement['rows']),'fields':['duration','team kills','explicit-role champion lineups'],
            'attribution':gm['attribution']}],
        'competitions':list(old_metadata.get('competitions',[]))+gm['competitions'],
        'actual_completed_maps':len(rows),
        'expected_completed_maps':old_metadata.get('expected_completed_maps',len(base_rows))+gm['expected_completed_maps'],
        'completed_matches':len({r['series_id'] for r in rows if r.get('series_verified') is not False}),
        'unlinked_maps':sum(r.get('series_verified') is False for r in rows),
        'complete':old_metadata.get('complete',False) and gm['complete'],
        'missing':list(old_metadata.get('missing',[]))+gm['missing'],
        'teamAliases':{**old_metadata.get('teamAliases',{}),**gm['teamAliases']},
        'fetchedAt':gm['fetchedAt'],'cutoff':gm['cutoff'],
        'latestDate':rows[-1]['date'],'historyAvailableThrough':max((r['available_at'] for r in rows),key=instant),
        'scope':old_metadata.get('scope','')+' 另收录ChainCC公开的2026 LCK、LEC、LCS、LCP、CBLOL；不表示所有赛区无缺局。',
        'limitations':list(old_metadata.get('limitations',[]))+gm['limitations']})
    metadata['limitations']=[line for line in metadata['limitations'] if line!='尚未覆盖所有Worlds参赛队本土联赛。']
    metadata['limitations']=[('旧腾讯来源未提供已核验版本；新增CSV与Riot数据保留其公开版本字段。' if line=='官方页面未提供已核验的版本字段。' else line) for line in metadata['limitations']]
    metadata['limitations'].append('已收录五大赛区；2026-08-01 LCK GEN–DK第一局缺少可靠局内时长，仍保留缺口。')
    team_coverage=[]
    for team in sorted({r[k] for r in rows for k in ('team_a','team_b')}):
        rr=[r for r in rows if team in (r['team_a'],r['team_b'])]
        team_coverage.append({'team':team,'maps':len(rr),
            'series':len({r['series_id'] for r in rr if r.get('series_verified') is not False}),
            'unlinked_maps':sum(r.get('series_verified') is False for r in rr),
            'team_ids':sorted({r['team_a_id'] if r['team_a']==team else r['team_b_id'] for r in rr}),
            'latestDate':max((r['date'] for r in rr),key=instant),'tournaments':sorted({r['tournament'] for r in rr})})
    metadata['teamCoverage']=team_coverage
    draft=copy.deepcopy(old_metadata.get('draftCoverage',{}))
    draft.update({'totalMaps':len(rows),'verifiedMaps':sum(r.get('draft_verified') is True for r in rows),
        'bySource':{**draft.get('bySource',{}),'chaincc':len(supplement['rows'])},
        'lineupCount':2*len(rows),'championSelections':10*len(rows),
        'historicalChampions':len({c for r in rows for key in ('lineup_a','lineup_b') for c in r.get(key,{}).values()}),
        'complete':all(r.get('draft_verified') is True for r in rows),
        'source_urls':list(dict.fromkeys(draft.get('source_urls',[])+[SOURCE])),
        'globalSource':gm['draftCoverage']})
    metadata['draftCoverage']=draft
    return {'rows':rows,'fixtures':copy.deepcopy(base.get('fixtures',[])),'metadata':metadata}
def canonical_text(value): return re.sub(r'[^a-z0-9]','',value.casefold())
def integer(value):
    number=float(value)
    assert number.is_integer(), f'Expected integer: {value}'
    return int(number)
def instant(value): return dt.datetime.fromisoformat(value.replace('Z','+00:00'))
def read_csv(path):
    with gzip.open(path,'rt',encoding='utf-8-sig',newline='') as handle:
        yield from csv.DictReader(handle)

def fetch_sources(raw):
    """Ordinary public CSV downloads using curl; no cookies, key or login."""
    raw.mkdir(parents=True,exist_ok=True)
    old=load(raw/'fetch-manifest.json') if (raw/'fetch-manifest.json').exists() else []
    records=[]
    for kind in ('teams','players'):
        url=f'https://chaincc.lol/data/chaincc-{kind}-2026.csv.gz'
        target=raw/f'{kind}-2026.csv.gz';temporary=raw/f'.{kind}-2026.download'
        try:
            subprocess.run(['curl','--fail','--location','--silent','--show-error','--retry','2',
                '--max-time','240','--output',str(temporary),url],check=True)
            row_count=sum(1 for _ in read_csv(temporary))
            assert row_count>0, 'Public source CSV is empty'
            digest=hashlib.sha256(temporary.read_bytes()).hexdigest()
            now=dt.datetime.now(dt.timezone.utc).isoformat()
            previous=next((r for r in old if r['file']==target.name and r['sha256']==digest),None)
            record={'source':url,'file':target.name,'bytes':temporary.stat().st_size,'sha256':digest,
                    'rows':row_count,'observed_at':previous['observed_at'] if previous else now,'fetched_at':now}
            os.replace(temporary,target);records.append(record)
            print(json.dumps({'downloaded':target.name,'rows':row_count,'bytes':record['bytes']}),flush=True)
        finally:
            if temporary.exists():temporary.unlink()
    atomic_save(raw/'fetch-manifest.json',records)
    # The page's publication date is separate from the CSV observation timestamp.
    response=subprocess.run(['curl','--fail','--location','--silent','--show-error','--max-time','30',SOURCE],capture_output=True,text=True)
    updated=None
    if response.returncode==0:
        plain=re.sub('<[^>]+>',' ',response.stdout)
        found=re.search(r'Updated\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})',plain)
        if found:
            try:updated=dt.datetime.strptime(found.group(1),'%B %d, %Y').date().isoformat()
            except ValueError:pass
    atomic_save(raw/'publisher.json',{'source_url':SOURCE,'updated_at':updated,'license':'CC BY 4.0'})

def normalize(args):
    manifests=load(args.raw/'fetch-manifest.json')
    for item in manifests:
        file=args.raw/item['file']
        assert hashlib.sha256(file.read_bytes()).hexdigest()==item['sha256'], 'Source file hash differs from observed manifest'
    observed=max((instant(m['observed_at']) for m in manifests),default=None)
    assert observed is not None and observed<=dt.datetime.now(dt.timezone.utc), 'Missing or future observation timestamp'
    raw_champions=load(args.champions)
    publisher=load(args.raw/'publisher.json') if (args.raw/'publisher.json').exists() else {}
    source_updated=publisher.get('updated_at')
    champion_lookup={}
    for champ in raw_champions['data'].values():
        for name in (champ['name'],champ['id']): champion_lookup[canonical_text(name)]=champ['id']
    existing=load(args.existing)
    aliases={**existing['metadata'].get('teamAliases',{}),**EXTRA_ALIASES}
    folded_aliases={name.casefold():code for name,code in aliases.items()}
    canonical_team=lambda name:folded_aliases.get(name.casefold(),name)
    known_ids={}
    for row in existing['rows']:
        for side in ('a','b'): known_ids.setdefault(row['team_'+side],row.get('team_'+side+'_id'))

    games=collections.defaultdict(list)
    excluded_year=0;all_team_rows=0;selected_rows=0;all_league_counts=collections.Counter()
    for row in read_csv(args.raw/'teams-2026.csv.gz'):
        all_team_rows+=1;all_league_counts[row['league']]+=1
        if not row['date'].startswith('2026-'):
            excluded_year+=1;continue
        if row['league'] not in args.leagues:continue
        games[row['game_id']].append(row);selected_rows+=1
    players=collections.defaultdict(list);all_player_rows=0
    required=('game_id','date','league','team_name','opponent_team_name','side','position','champion','result','gamelength','kills','teamkills')
    for row in read_csv(args.raw/'players-2026.csv.gz'):
        all_player_rows+=1
        if row['game_id'] in games: players[(row['game_id'],row['side'])].append({k:row[k] for k in required})
    series_manifest=load(args.series_map) if args.series_map else {}
    series_map=series_manifest
    if isinstance(series_map,dict) and 'by_source_game_id' in series_map:series_map=series_map['by_source_game_id']
    rows,missing=[],[]
    for game_id,teams in sorted(games.items()):
        try:
            assert len(teams)==2 and {t['side'] for t in teams}=={'Blue','Red'}, 'Expected one team per side'
            teams.sort(key=lambda t:0 if t['side']=='Blue' else 1)
            a,b=teams
            for field in ('date','league','split','patch','game_number','gamelength'):
                assert a[field]==b[field], f'Team rows disagree on {field}'
            assert a['opponent_team_name']==b['team_name'] and b['opponent_team_name']==a['team_name']
            assert {a['result'],b['result']}=={'TRUE','FALSE'}, 'Winner not recorded unambiguously'
            game_number=integer(a['game_number']);assert 1<=game_number<=9
            duration=integer(a['gamelength']);assert 60<=duration<=10800
            naive=dt.datetime.strptime(a['date'],'%Y-%m-%d %H:%M:%S')
            earliest=(naive-dt.timedelta(hours=14)).replace(tzinfo=dt.timezone.utc)
            latest=(naive+dt.timedelta(hours=12)).replace(tzinfo=dt.timezone.utc)
            assert latest<observed, 'Cannot conservatively establish that source game preceded observation'
            lineups={};kills={}
            for label,team in (('a',a),('b',b)):
                pp=players[(game_id,team['side'])]
                assert len(pp)==5, 'Expected five player rows per team'
                lineup={}
                for player in pp:
                    for field in ('date','league','team_name','opponent_team_name','side','result','gamelength','teamkills'):
                        assert player[field]==team[field], f'Player/team {field} disagrees'
                    role=ROLES[player['position']]
                    assert role not in lineup, 'Duplicate explicit position'
                    lineup[role]=champion_lookup[canonical_text(player['champion'])]
                assert set(lineup)==set(ROLES.values()) and len(set(lineup.values()))==5
                picks={champion_lookup[canonical_text(team[f'pick{i}'])] for i in range(1,6)}
                assert picks==set(lineup.values()), 'Player champions differ from team draft picks'
                lineups[label]=lineup
                kills[label]=integer(team['kills'])
                assert 0<=kills[label]<=200 and kills[label]==integer(team['teamkills'])
                assert sum(integer(p['kills']) for p in pp)==kills[label], 'Participant kill sum differs from team kills'
            assert len(set(lineups['a'].values())|set(lineups['b'].values()))==10
            ta,tb=canonical_team(a['team_name']),canonical_team(b['team_name'])
            assert ta!=tb
            tournament=a['league'].lower()
            event='2026 '+a['league']+(' · '+a['split'] if a['split'] else '')+(' · 季后赛' if a['playoffs']=='TRUE' else '')
            row={'id':'lol-chaincc-'+game_id,'source_game_id':game_id,
                'series_id':'lol-chaincc-unlinked:'+game_id,'series_verified':False,'series_complete':False,
                'series_id_basis':'per_game_placeholder','date':latest.isoformat(),
                'source_date':a['date'],'source_date_raw':a['date'],
                'date_basis':'unknown_timezone_upper_bound','source_timezone':'unknown',
                'source_time_earliest':earliest.isoformat(),'source_time_latest':latest.isoformat(),
                'actual_start':None,'actual_end':None,'available_at':observed.isoformat(),
                'observed_at':observed.isoformat(),'availability_basis':'observed_snapshot','backtest_eligible':False,
                'season':'2026','game':'lol','event':event,'league':a['league'],'region':REGIONS.get(a['league'],a['league']),
                'tournament':tournament,'tournament_id':'chaincc:2026:'+tournament,'patch':a['patch'],
                'team_a':ta,'team_b':tb,'source_team_a':a['team_name'],'source_team_b':b['team_name'],
                'team_a_id':known_ids.get(ta) or a['team_id'],'team_b_id':known_ids.get(tb) or b['team_id'],
                'source_team_a_id':a['team_id'],'source_team_b_id':b['team_id'],
                'map':game_number,'duration_sec':duration,'kills_a':kills['a'],'kills_b':kills['b'],
                'winner':ta if a['result']=='TRUE' else tb,'side_a':'blue','side_b':'red',
                'lineup_a':lineups['a'],'lineup_b':lineups['b'],'draft_verified':True,
                'draft_role_source':'ChainCC player CSV position, joined by game_id and side',
                'draft_source_url':SOURCE,'draft_data_url':'https://chaincc.lol/data/chaincc-players-2026.csv.gz',
                'source':'ChainCC open esports dataset (upstream Oracle’s Elixir and other public sources)',
                'source_url':SOURCE,'data_url':'https://chaincc.lol/data/chaincc-teams-2026.csv.gz',
                'duration_source_url':SOURCE,'kills_source_url':SOURCE,
                'license':'CC BY 4.0','attribution':'ChainCC. League of Legends esports match dataset. https://chaincc.lol/free/data',
                'verified':True,'synthetic':False}
            if game_id in series_map:
                link=series_map[game_id]
                assert link.get('series_verified') is True and link.get('source_url'), 'Series mapping lacks verification provenance'
                assert set(link['teams'])=={ta,tb} and integer(link['map'])==game_number
                assert integer(link['bo']) in (1,3,5,7,9) and game_number<=integer(link['bo'])
                row.update({'series_id':str(link['series_id']),'series_verified':True,'bo':integer(link['bo']),
                            'series_complete':link.get('series_complete') is True,
                            'series_id_basis':'official_schedule_mapping','series_source_url':link['source_url'],
                            'riot_series_id':link.get('riot_series_id'),'riot_game_id':link.get('riot_game_id'),
                            'series_mapping_evidence':link.get('mapping_evidence'),
                            'official_tournament_id':link.get('official_tournament_id'),
                            'official_tournament_name':link.get('official_tournament_name')})
                if link.get('scheduled_at'):
                    row['scheduled_at']=link['scheduled_at']
                    row['date']=link['scheduled_at']
                    row['date_basis']='official_scheduled_series_start'
            rows.append(row)
        except (AssertionError,KeyError,ValueError) as error:
            missing.append({'source_game_id':game_id,'reason':str(error),'error_type':type(error).__name__})
    rows.sort(key=lambda r:(r['date'],r['id']))
    assert len({r['id'] for r in rows})==len(rows)
    coverage=[]
    official_coverage=load(args.official_series).get('coverage',{}) if args.official_series else {}
    for league in args.leagues:
        rr=[r for r in rows if r['league']==league]
        coverage.append({'id':'regional:'+league.lower(),'name':league,'league':league,'maps':len(rr),
            'expected_maps':official_coverage.get(league,{}).get('maps',len(rr)),
            'actual_maps':len(rr),'completed_series':len({r['series_id'] for r in rr if r['series_verified']}),
            'unlinked_maps':sum(not r['series_verified'] for r in rr),
            'source_updated_at':source_updated,
            'teams':len({r[k] for r in rr for k in ('team_a','team_b')}),
            'firstSourceDate':min((r['source_date_raw'] for r in rr),default=None),
            'latestSourceDate':max((r['source_date_raw'] for r in rr),default=None),
            'verifiedSeriesMaps':sum(r['series_verified'] for r in rr)})
    team_coverage=[]
    for team in sorted({r[k] for r in rows for k in ('team_a','team_b')}):
        rr=[r for r in rows if team in (r['team_a'],r['team_b'])]
        names=sorted({r['source_team_a'] if r['team_a']==team else r['source_team_b'] for r in rr})
        for name in names:aliases[name]=team
        team_coverage.append({'team':team,'source_names':names,'maps':len(rr),
            'tournaments':sorted({r['tournament'] for r in rr}),
            'latestSourceDate':max(r['source_date_raw'] for r in rr)})
    series_issues=series_manifest.get('issues',[]) if isinstance(series_manifest,dict) else []
    source_gaps=[{'provider':'ChainCC / Riot','league':issue.get('league'),
        'series_id':issue.get('series_id'),'reason':'Official completed map missing from publisher CSV; the partial series is not marked verified.',
        'missing_maps':sorted(set(issue.get('official_maps',[]))-set(issue.get('observed_maps',[]))),
        'observed_maps':issue.get('observed_maps',[]),'scheduled_at':issue.get('scheduled_at'),
        'source_url':'https://lolesports.com/en-US/leagues/'+issue.get('league','').lower()} for issue in series_issues]
    metadata={'year':2026,'game':'lol','source':'ChainCC open esports dataset','source_url':SOURCE,
        'license':'CC BY 4.0','license_url':'https://creativecommons.org/licenses/by/4.0/',
        'attribution':'ChainCC. League of Legends esports match dataset. chaincc.lol/free/data (accessed 2026-10-08).',
        'methodology_url':METHOD,'sourcePageUpdated':source_updated,'observed_at':observed.isoformat(),
        'fetchedAt':observed.isoformat(),'cutoff':observed.isoformat(),'rawManifest':manifests,
        'actual_completed_maps':len(rows),'expected_completed_maps':sum(c['expected_maps'] for c in coverage),
        'publisher_expected_maps':len(games),'complete':not missing and not source_gaps,
        'missing':missing+source_gaps,'normalizationIssues':missing,'seriesIssues':series_issues,
        'competitions':coverage,'teamCoverage':team_coverage,'teamAliases':aliases,
        'rawTeamRows':all_team_rows,'rawPlayerRows':all_player_rows,'selectedTeamRows':selected_rows,
        'rejectedNon2026TeamRows':excluded_year,'rawLeagues':dict(all_league_counts),
        'draftCoverage':{'totalMaps':len(rows),'verifiedMaps':sum(r['draft_verified'] for r in rows),'catalogVersion':raw_champions['version']},
        'verifiedSeriesMaps':sum(r['series_verified'] for r in rows),
        'timePolicy':{'date':'Official scheduled UTC series start when series is verified; otherwise upper UTC bound of timezone-unspecified source datetime under offsets -12 to +14 hours. Neither is an actual start.',
            'available_at':'Actual observation time of the complete, hashed team and player snapshots; not match end.',
            'actual_end':'Unknown, kept null. Game duration is never added to source timestamp.',
            'historical_backtest':'Excluded as targets and unavailable for training before observed_at.'},
        'checks':['Two opposite-side team rows per game','Five explicit player positions per team','Team and player draft champion sets agree',
                  'Team and five-player kill sums agree','Game winner and duration agree across source rows','English champion display names mapped with official Data Dragon IDs'],
        'limitations':['CSV does not provide real series identifiers, BO formats, actual completion times, or timezone labels.',
            'Per-game series placeholders are not completed series or BO1 matches.',
            'Data coverage is publisher coverage, not independently proved exhaustive regional coverage.',
            'EWC, LPL and international tournaments are excluded by default to avoid qualifier ambiguity and duplicate current records.']}
    snapshot={'rows':rows,'fixtures':[],'metadata':metadata}
    save(args.output,snapshot)
    save(args.report,metadata)
    print(json.dumps({'rows':len(rows),'expected':len(games),'missing':len(missing),'coverage':coverage},ensure_ascii=False,indent=2))
    return snapshot

def update(args):
    if args.fetch:
        fetch_sources(args.raw)
        subprocess.run([sys.executable,str(ROOT/'collect-riot-series.py'),'--output-dir',str(args.riot_cache),
                        '--year','2026','--refresh'],check=True)
    official=args.riot_cache/'riot-series-2026.json'
    if not official.exists():raise ValueError('Official series cache missing; run with --fetch or provide --riot-cache.')
    # Normalize first without grouping, then independently verify whole series.
    options=argparse.Namespace(raw=args.raw,champions=args.champions,existing=args.base,
        series_map=None,official_series=None,leagues=list(DEFAULT_LEAGUES),
        output=args.cache/'unlinked-candidate.json',report=args.cache/'unlinked-report.json')
    first=normalize(options)
    if first['metadata']['normalizationIssues']:raise ValueError('Source validation failed; published snapshot is unchanged.')
    subprocess.run([sys.executable,str(ROOT/'map-chaincc-series.py'),'--series',str(official),
        '--rows',str(options.output),'--output',str(args.riot_cache/'series-map.json'),
        '--audit',str(args.riot_cache/'series-audit.json')],check=True)
    options.series_map=args.riot_cache/'series-map.json';options.official_series=official
    options.output=args.cache/'normalized.json';options.report=args.cache/'coverage-report.json'
    supplement=normalize(options)
    base=load(args.base);previous=load(args.output) if args.output.exists() else None
    merged=merge_snapshots(base,supplement,previous)
    assert all(r.get('draft_verified') is True for r in merged['rows']), 'Merged data contains unverified drafts'
    # Rebuild only history counts; preserve the official Chinese catalog identities.
    catalog=load(args.catalog)
    champion_counts=collections.Counter();role_counts=collections.defaultdict(collections.Counter)
    for row in merged['rows']:
        for side in ('a','b'):
            for role,champion in row['lineup_'+side].items():
                champion_counts[champion]+=1;role_counts[champion][role]+=1
    assert set(champion_counts)<={c['id'] for c in catalog['champions']}, 'Chinese hero catalog needs an explicit update before publishing'
    for champion in catalog['champions']:
        champion['historical_picks']=champion_counts[champion['id']]
        champion['observed_roles']=dict(role_counts[champion['id']])
    catalog['counts_updated_at']=dt.datetime.now(dt.timezone.utc).isoformat()
    atomic_save(args.output,merged);atomic_save(args.catalog_output,catalog)
    summary={'maps':len(merged['rows']),'complete_series':merged['metadata']['completed_matches'],
        'unlinked_maps':merged['metadata']['unlinked_maps'],'teams':len(merged['metadata']['teamCoverage']),
        'output':str(args.output),'report':str(options.report)}
    atomic_save(args.cache/'integration-report.json',summary)
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fetch',action='store_true',help='Refresh public CSVs and official Riot completed schedule; failure never falls back silently.')
    parser.add_argument('--base',type=pathlib.Path,default=ROOT/'dist/lol-data.json',help='Base candidate or current snapshot. Existing ChainCC rows are rebuilt, never appended twice.')
    parser.add_argument('--output',type=pathlib.Path,default=ROOT/'dist/lol-data.json')
    parser.add_argument('--cache',type=pathlib.Path,default=ROOT/'cache/global-lol')
    parser.add_argument('--raw',type=pathlib.Path,default=ROOT/'cache/global-lol/raw')
    parser.add_argument('--riot-cache',type=pathlib.Path,default=ROOT/'cache/global-lol/riot')
    parser.add_argument('--champions',type=pathlib.Path,default=ROOT/'data-sources/ddragon/16.20.1-en_US.json')
    parser.add_argument('--catalog',type=pathlib.Path,default=ROOT/'dist/champions.json')
    parser.add_argument('--catalog-output',type=pathlib.Path,default=ROOT/'dist/champions.json')
    args=parser.parse_args()
    if args.output.resolve()==args.catalog_output.resolve():parser.error('Snapshot and catalog outputs must differ.')
    try:update(args)
    except (AssertionError,ValueError,KeyError,OSError,subprocess.CalledProcessError) as error:
        print(f'Global update failed; no candidate was published: {error}',file=sys.stderr)
        sys.exit(2)

#!/usr/bin/env python3
"""Add source-verified champion drafts to real LoL rows without inferring roles.

Inputs are an existing snapshot, official Tencent match-detail caches, archived
Riot feed caches, and a Data Dragon champion JSON. The catalog is used for stable
identity and translated labels, not historical patch statistics or role guesses.
All non-draft row fields and fixture/metadata contents are preserved.
"""
import argparse
import collections
import copy
import datetime as dt
import json
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
ROLES = ('top','jungle','mid','bottom','support')
TENCENT_ROLES = {'TOP':'top','JUN':'jungle','MID':'mid','BOT':'bottom','SUP':'support'}
OWNED_FIELDS = ('lineup_a','lineup_b','side_a','side_b','draft_verified',
                'draft_source_url','draft_data_url','draft_role_source','draft_notes')
IDENTITY_FIELDS = ('id','game','series_id','match_id','map','team_a','team_b',
                   'team_a_id','team_b_id','riot_team_a_id','riot_team_b_id')

def read(path):
    return json.loads(path.read_text())

def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=path.parent,
                                         prefix='.'+path.name+'.',delete=False) as handle:
            temporary = pathlib.Path(handle.name)
            json.dump(value,handle,ensure_ascii=False,indent=2)
            handle.write('\n')
        os.replace(temporary,path)
    finally:
        if temporary is not None and temporary.exists(): temporary.unlink()

def build_catalog(raw):
    version = raw['version']
    source = f'https://ddragon.leagueoflegends.com/cdn/{version}/data/zh_CN/champion.json'
    champions = []
    for champ in raw['data'].values():
        assert champ['id'] and str(champ['key']).isdigit()
        champions.append({'id':champ['id'],'key':int(champ['key']),
            'name':champ['name'],'title':champ['title'],
            'icon':f"https://ddragon.leagueoflegends.com/cdn/{version}/img/champion/{champ['image']['full']}",
            'tags':champ.get('tags',[])})
    champions.sort(key=lambda x:x['id'])
    assert len({c['id'] for c in champions})==len(champions)
    assert len({c['key'] for c in champions})==len(champions)
    return {'version':version,'language':'zh_CN','source_url':source,
        'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
        'identity_field':'id','numeric_identity_field':'key',
        'role_note':'tags are champion classes, not player positions; draft roles come only from match data.',
        'champions':champions}

def require_lineup(lineup):
    assert set(lineup)==set(ROLES), f'Expected five distinct explicit positions, got {sorted(lineup)}'
    assert len(set(lineup.values()))==5, 'Repeated champion within one team'
    return {role:lineup[role] for role in ROLES}

def retained_draft(row, candidates, by_id):
    """Only reuse an explicitly verified draft for the identical map and teams.

    Reuse is allowed when a raw cache is absent. Conflicting available raw data
    never takes this path. The report separates retained from newly verified maps.
    """
    for old in candidates:
        if not old or old.get('draft_verified') is not True: continue
        if any(old.get(key)!=row.get(key) for key in IDENTITY_FIELDS): continue
        try:
            a=require_lineup(old['lineup_a']);b=require_lineup(old['lineup_b'])
            champions=set(a.values())|set(b.values())
            assert len(champions)==10 and champions<=set(by_id)
            assert {old['side_a'],old['side_b']}=={'blue','red'}
            assert old.get('draft_source_url') and old.get('draft_data_url')
            assert old.get('draft_role_source') in ('playerInfos.role','gameMetadata.participantMetadata.role')
            return {key:copy.deepcopy(old[key]) for key in OWNED_FIELDS if key in old}
        except (AssertionError,KeyError,TypeError):
            continue
    return None

def extract_tencent(row, cache, by_key):
    match_id = str(row['match_id'])
    raw = read(cache / (match_id+'.json'))
    assert raw.get('success') is True, 'Tencent cached response not successful'
    data = raw['data']
    assert str(data['matchId'])==match_id
    maps = [m for m in data['matchInfos'] if int(m['bo'])==int(row['map'])]
    assert len(maps)==1, 'Cannot identify exactly one map'
    game = maps[0]
    assert game['matchStatus']==2, 'Map not completed'
    row_ids = {}
    for label in ('a','b'):
        prefix,team_id = row['team_'+label+'_id'].split(':',1)
        assert prefix=='tencent-lol'
        row_ids[label] = str(team_id)
    teams = {str(t['teamId']):t for t in game['teamInfos']}
    assert set(teams)==set(row_ids.values()), 'Tencent map and row team IDs differ'
    assert str(game['blueTeam']) in teams, 'Unknown official blue-side team'
    lineups,sides,notes = {},{},[]
    for label,team_id in row_ids.items():
        team = teams[team_id]
        sides[label] = 'blue' if str(game['blueTeam'])==team_id else 'red'
        assert team['teamSide'].lower()==sides[label], 'Official side fields disagree'
        assert len(team['playerInfos'])==5, 'Team must have five participants'
        lineup = {}
        for player in team['playerInfos']:
            # role is the per-game quest/position, unlike roster playerLocation.
            assert player.get('isRole') is True, 'Per-game role is not verified in source'
            role = TENCENT_ROLES[player['role']]
            assert role not in lineup, 'Duplicate explicit role'
            champion = by_key[int(player['heroId'])]
            assert champion['id'].casefold()==player['heroNameEn'].casefold(), 'Champion numeric and string IDs disagree'
            lineup[role] = champion['id']
            if player['playerLocation']!=player['role']:
                notes.append({'team':row['team_'+label],'champion':champion['id'],
                    'roster_position':player['playerLocation'],'accepted_role':role,
                    'source_role':player['role'],
                    'supporting_role_item':player.get('roleItem',{}).get('itemName'),
                    'reason':'Per-game role differs from roster playerLocation; use explicit per-game role.'})
        lineups[label] = require_lineup(lineup)
    return lineups,sides,notes,row['source_url'],row['data_url'],'playerInfos.role'

def extract_riot(row, cache, by_id):
    game_id = row['id'].removeprefix('lol-riot-')
    raw = read(cache / (game_id+'-final.json'))
    initial = read(cache / (game_id+'-initial.json'))
    assert str(raw['esportsGameId'])==game_id
    assert str(raw['esportsMatchId'])==str(row['match_id'])
    assert raw['frames'][-1]['gameState']=='finished', 'Riot map not finished'
    row_ids = {label:str(row['riot_team_'+label+'_id']) for label in ('a','b')}
    meta = raw['gameMetadata']
    team_meta = {str(meta[side+'TeamMetadata']['esportsTeamId']):(side,meta[side+'TeamMetadata']) for side in ('blue','red')}
    assert set(team_meta)==set(row_ids.values()), 'Riot map and row team IDs differ'
    lineups,sides = {},{}
    for label,team_id in row_ids.items():
        side,team = team_meta[team_id]
        sides[label] = side
        original = initial['gameMetadata'][side+'TeamMetadata']
        assert str(original['esportsTeamId'])==team_id
        # Both pregame initialization and completed metadata must describe the same draft.
        picks = lambda t:sorted((p['role'],p['championId']) for p in t['participantMetadata'])
        assert picks(original)==picks(team), 'Riot initial and final draft metadata differ'
        assert len(team['participantMetadata'])==5
        lineup = {}
        for participant in team['participantMetadata']:
            role = participant['role']
            assert role in ROLES and role not in lineup, 'Unknown or repeated Riot role'
            champion = by_id[participant['championId']]
            lineup[role] = champion['id']
        lineups[label] = require_lineup(lineup)
    return lineups,sides,[],row.get('schedule_source_url','https://lolesports.com/en-US/leagues/demacia_cup'),row['data_url'],'gameMetadata.participantMetadata.role'

def enrich(args):
    snapshot = read(args.input)
    if not isinstance(snapshot.get('rows'),list) or not snapshot['rows']:
        raise ValueError('Input must contain a non-empty LoL rows list')
    assert len({row['id'] for row in snapshot['rows']})==len(snapshot['rows']), 'Duplicate map IDs in input'
    previous_path = args.previous or args.output
    previous = read(previous_path) if previous_path.exists() else {'rows':[]}
    if args.base_only:
        assert all(row['id'].startswith(('lol-tencent-','lol-riot-')) for row in snapshot['rows']), 'Base-only staging accepts only Tencent/Riot rows'
        assert args.output.resolve()!=(ROOT/'dist/lol-data.json').resolve(), 'Base-only output must be staged outside the published snapshot'
        previous={**previous,'rows':[row for row in previous.get('rows',[]) if row['id'].startswith(('lol-tencent-','lol-riot-'))]}
    previous_rows = {row['id']:row for row in previous.get('rows',[])}
    current_ids = {row['id'] for row in snapshot['rows']}
    dropped_verified = sorted(row['id'] for row in previous.get('rows',[])
                              if row.get('draft_verified') is True and row['id'] not in current_ids)
    catalog = build_catalog(read(args.champions_raw))
    by_key = {c['key']:c for c in catalog['champions']}
    by_id = {c['id']:c for c in catalog['champions']}
    missing,conflicts = [],[]
    reused = []
    counts = collections.Counter()
    champion_counts = collections.Counter()
    role_counts = collections.defaultdict(collections.Counter)
    for row in snapshot['rows']:
        original = copy.deepcopy(row)
        for field in OWNED_FIELDS: row.pop(field,None)
        row.update({'side_a':'unknown','side_b':'unknown','draft_verified':False})
        try:
            assert row.get('game')=='lol'
            try:
                if row['id'].startswith('lol-tencent-'):
                    provider='tencent';result = extract_tencent(row,args.tencent_cache,by_key)
                elif row['id'].startswith('lol-riot-'):
                    provider='riot';result = extract_riot(row,args.riot_cache,by_id)
                else: raise ValueError('Unsupported public data row provider')
                lineups,sides,notes,source,data_url,role_source = result
                assert sides['a']!=sides['b']
                assert len(set(lineups['a'].values())|set(lineups['b'].values()))==10, 'Champion appears on both teams'
                row.update({'lineup_a':lineups['a'],'lineup_b':lineups['b'],
                    'side_a':sides['a'],'side_b':sides['b'],'draft_verified':True,
                    'draft_source_url':source,'draft_data_url':data_url,
                    'draft_role_source':role_source,'draft_notes':notes})
            except FileNotFoundError as error:
                saved = retained_draft(row,[original,previous_rows.get(row['id'])],by_id)
                if saved is None: raise
                row.update(saved)
                lineups={'a':row['lineup_a'],'b':row['lineup_b']}
                notes=row.get('draft_notes',[]);source=row['draft_source_url']
                reused.append({'id':row['id'],'reason':'Raw cache missing; retained previously verified draft for identical game/team IDs.'})
            counts[provider]+=1
            if notes: conflicts.append({'id':row['id'],'notes':notes,'source_url':source})
            for lineup in lineups.values():
                for role,champion in lineup.items():
                    champion_counts[champion]+=1;role_counts[champion][role]+=1
        except (AssertionError,KeyError,ValueError,TypeError,FileNotFoundError) as error:
            missing.append({'id':row.get('id'),'reason':f'{type(error).__name__}: {error}'})
    for champion in catalog['champions']:
        champion['historical_picks'] = champion_counts[champion['id']]
        champion['observed_roles'] = {role:role_counts[champion['id']][role] for role in ROLES if role_counts[champion['id']][role]}
    report = {'totalMaps':len(snapshot['rows']),'verifiedMaps':sum(counts.values()),
        'missingMaps':len(missing),'complete':not missing and not dropped_verified,'bySource':dict(counts),
        'freshlyVerifiedMaps':sum(counts.values())-len(reused),'retainedVerifiedMaps':len(reused),
        'retainedDrafts':reused,
        'positions':list(ROLES),'catalogVersion':catalog['version'],
        'catalogChampions':len(catalog['champions']),'historicalChampions':len(champion_counts),
        'lineupCount':2*sum(counts.values()),'championSelections':sum(champion_counts.values()),
        'source_urls':[catalog['source_url'],'https://lpl.qq.com/','https://lolesports.com/en-US/leagues/demacia_cup'],
        'roleSources':{'tencent':'playerInfos.role (not playerLocation or array order)',
                       'riot':'gameMetadata participantMetadata.role'},
        'roleConflicts':conflicts,'missing':missing,
        'droppedPreviouslyVerifiedMaps':len(dropped_verified),
        'droppedPreviouslyVerifiedMapIds':dropped_verified,
        'outputWritten':not (missing or dropped_verified) or args.allow_partial,
        'warnings':([f'{len(reused)} maps reused existing verified drafts because raw caches were absent; they were not freshly reverified.'] if reused else [])+
                   ([f'{len(missing)} maps lack verified drafts; output '+('will be partial by explicit request.' if args.allow_partial else 'is unchanged.')] if missing else [])+
                   ([f'{len(dropped_verified)} previously verified maps are absent from candidate data; output '+('will omit them by explicit request.' if args.allow_partial else 'is unchanged.')] if dropped_verified else []),
        'checks':['Team IDs match row IDs before assigning blue/red side',
                  'Tencent numeric heroId matches canonical Data Dragon ID and heroNameEn',
                  'Riot initial/final draft metadata agree',
                  'Five distinct explicit roles and champions per team; ten champions per map',
                  'Existing outcomes and time-availability fields preserved'],
        'limitations':['Catalog version identifies current champion names and icons only; it does not impute historical patch data.',
                       'Historical observed roles are counts, not mandatory champion-position rules.',
                       'Full lineups are pre-game inputs only after champion selection has completed.'],
        'enrichedAt':dt.datetime.now(dt.timezone.utc).isoformat()}
    atomic_write(args.report,report)
    if (missing or dropped_verified) and not args.allow_partial:
        print(json.dumps({'error':'Draft verification incomplete; snapshot and champion catalog left unchanged.',
            'missingMaps':len(missing),'droppedPreviouslyVerifiedMaps':len(dropped_verified),'report':str(args.report)},ensure_ascii=False),file=sys.stderr)
        return 2
    snapshot.setdefault('metadata',{})['draftCoverage'] = report
    atomic_write(args.output,snapshot)
    atomic_write(args.catalog_output,catalog)
    print(json.dumps({key:report[key] for key in ('totalMaps','verifiedMaps','freshlyVerifiedMaps','retainedVerifiedMaps','missingMaps','droppedPreviouslyVerifiedMaps','warnings')},ensure_ascii=False))
    print(json.dumps({'snapshot':str(args.output),'catalog':str(args.catalog_output),'report':str(args.report)},ensure_ascii=False))
    return 0

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=pathlib.Path,default=ROOT/'dist/lol-data.json',help='Merged candidate snapshot; defaults to the published snapshot.')
    parser.add_argument('--output',type=pathlib.Path,default=ROOT/'dist/lol-data.json',help='Written atomically only after verification succeeds.')
    parser.add_argument('--previous',type=pathlib.Path,help='Previously verified snapshot used if raw caches are absent; defaults to --output.')
    parser.add_argument('--tencent-cache',type=pathlib.Path,default=ROOT/'cache/lol')
    parser.add_argument('--riot-cache',type=pathlib.Path,default=ROOT/'cache/lol-riot')
    parser.add_argument('--champions-raw',type=pathlib.Path,default=ROOT/'data-sources/ddragon/16.20.1-zh_CN.json')
    parser.add_argument('--catalog-output',type=pathlib.Path,default=ROOT/'dist/champions.json')
    parser.add_argument('--report',type=pathlib.Path,default=ROOT/'cache/lol/draft-coverage.json')
    parser.add_argument('--allow-partial',action='store_true',help='Explicitly allow missing drafts or removal of previously verified maps; otherwise those changes block writes.')
    parser.add_argument('--base-only',action='store_true',help='Stage Tencent/Riot rows only; exclude other providers from the previous-row guard. Cannot target dist/lol-data.json; final global merge still guards every published game ID.')
    args=parser.parse_args()
    outputs=[args.output.resolve(),args.catalog_output.resolve(),args.report.resolve()]
    if len(set(outputs))!=len(outputs) or args.input.resolve() in outputs[1:]:
        parser.error('Snapshot, champion catalog, and report must use distinct output paths.')
    sys.exit(enrich(args))

#!/usr/bin/env python3
"""Cross-reference ChainCC maps to official Riot schedule without declaring naive dates UTC.
Candidate window permits any practical timezone (+14 to -12), plus series running time.
Only unique official pair/game-number matches whose full series counts and winners agree are verified.
"""
import argparse,json,pathlib,datetime as dt,unicodedata,re,collections
ROOT=pathlib.Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--series',type=pathlib.Path,default=ROOT/'riot-series-2026.json')
parser.add_argument('--rows',type=pathlib.Path,default=ROOT.parent/'global-lol-data/global-lol-data.json')
parser.add_argument('--output',type=pathlib.Path,default=ROOT/'series-map.json')
parser.add_argument('--audit',type=pathlib.Path,default=ROOT/'series-audit.json')
args=parser.parse_args()
R=json.loads(args.series.read_text())
S=json.loads(args.rows.read_text())
def norm(s):
 s=s.replace('Ø','O').replace('ø','o')
 return re.sub(r'[^a-z0-9]','',unicodedata.normalize('NFKD',s).encode('ascii','ignore').decode().lower())
# Explicit publisher naming variants, otherwise exact normalized spelling.
ALIASES={'gengesports':'geng','cloud9kia':'cloud9','teamliquidalienware':'teamliquid','relovedeepcrossgaming':'deepcrossgaming','redkalunga':'redcanids'}
def name(s):
 n=norm(s);return ALIASES.get(n,n)
def pair(e):return frozenset(name(t['name']) for t in e['matchTeams'])
def date(s):return dt.datetime.fromisoformat(s.replace('Z','+00:00'))
es=R['series'];bykey=collections.defaultdict(list)
for e in es:bykey[(e['league']['name'],pair(e))].append(e)
assignments={};issues=[];groups=collections.defaultdict(list)
for r in S['rows']:
 key=(r['league'],frozenset(name(r[k]) for k in ('source_team_a','source_team_b')))
 raw=dt.datetime.fromisoformat(r['source_date_raw']).replace(tzinfo=dt.timezone.utc)
 # Not a timezone conversion: use raw clock solely to bound candidate calendar neighborhood.
 # A +/- 48h window comfortably includes timezone ambiguity and prolonged series; never choose nearest.
 candidates=[e for e in bykey[key] if abs((raw-date(e['startTime'])).total_seconds())<=48*3600 and any(g['number']==r['map'] and g['state']=='completed' for g in e['match']['games'])]
 if len(candidates)!=1:
  issues.append({'source_game_id':r['source_game_id'],'reason':'ambiguous_or_missing_candidate','candidate_ids':[e['id'] for e in candidates],'teams':list(key[1]),'source_date_raw':r['source_date_raw']});continue
 e=candidates[0];assignments[r['source_game_id']]=e;groups[e['id']].append(r)
links={};series_audit=[]
for event_id,rows in groups.items():
 e=assignments[rows[0]['source_game_id']];games=[g for g in e['match']['games'] if g['state']=='completed'];expected_nums=sorted(g['number'] for g in games)
 actual_nums=sorted(r['map'] for r in rows)
 official_wins={name(t['name']):t['result']['gameWins'] for t in e['matchTeams']}
 observed_wins=collections.Counter(name(r['source_team_a'] if r['winner']==r['team_a'] else r['source_team_b']) for r in rows)
 wins={t:observed_wins[t] for t in official_wins}
 valid=actual_nums==expected_nums and wins==official_wins and len(actual_nums)==len(set(actual_nums))
 audit={'series_id':e['id'],'league':e['league']['name'],'scheduled_at':e['startTime'],'teams':[t['name'] for t in e['matchTeams']],'official_maps':expected_nums,'observed_maps':actual_nums,'official_wins':official_wins,'observed_wins':wins,'verified':valid}
 series_audit.append(audit)
 if not valid:
  issues.append({'reason':'series_count_or_score_mismatch',**audit});continue
 gm={g['number']:g['id'] for g in games}
 for r in rows:
  links[r['source_game_id']]={'series_verified':True,'series_complete':True,'series_id':'riot:'+e['id'],'riot_series_id':e['id'],'riot_game_id':gm[r['map']],'teams':[r['team_a'],r['team_b']],'map':r['map'],'bo':e['match']['strategy']['count'],'source_url':'https://lolesports.com/en-US/leagues/'+e['league']['slug'],'scheduled_at':e['startTime'],'date_basis':'official_scheduled_series_start','mapping_evidence':'Unique official league/team-pair/game-number within conservative +/-48h raw-calendar candidate window; full series completed-map numbers and team win totals agree. Source naive datetime is not relabeled UTC.','official_tournament_id':e['tournament']['id'],'official_tournament_name':e['tournament']['name']}
coverage={league:{'maps':sum(r['league']==league for r in S['rows']),'verifiedMaps':sum(r['league']==league and r['source_game_id'] in links for r in S['rows']),'verifiedSeries':sum(x['league']==league and x['verified'] for x in series_audit)} for league in ['LCK','LEC','LCS','LCP','CBLOL']}
out={'fetchedAt':R['fetchedAt'],'notes':['Only exact series scores and complete map-number sets validate a series.','Scheduled start is not actual start. Retain observed_snapshot availability and backtest_eligible=false until independently timestamp-verified.'],'coverage':coverage,'by_source_game_id':links,'issues':issues}
args.output.parent.mkdir(parents=True,exist_ok=True);args.audit.parent.mkdir(parents=True,exist_ok=True)
args.output.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
args.audit.write_text(json.dumps(series_audit,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'coverage':coverage,'linked':len(links),'issues':issues},ensure_ascii=False,indent=2))

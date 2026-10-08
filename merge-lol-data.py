#!/usr/bin/env python3
"""Merge separately verified Tencent and Demacia snapshots, preserving provenance."""
import argparse
import datetime as dt
import json
import pathlib

ROOT=pathlib.Path(__file__).resolve().parent
def instant(value): return dt.datetime.fromisoformat(value.replace('Z','+00:00'))
def merge(base_path,demacia_path,output_path):
    base=json.loads(base_path.read_text()); extra=json.loads(demacia_path.read_text())
    rows=[r for r in base['rows'] if r['tournament']!='demacia']+extra['rows']
    assert len({r['id'] for r in rows})==len(rows)
    for row in rows:
        assert row['season']=='2026' and row['game']=='lol'
        assert instant(row['date'])<instant(row['available_at'])
        row.setdefault('duration_source_url',row['source_url'])
        row.setdefault('kills_source_url',row['source_url'])
    rows.sort(key=lambda r:(instant(r['date']),r['series_id'],r['map']))
    metadata={**base['metadata']}
    metadata.update({
        'source':'腾讯官方赛事数据 / Riot Games 官方选手数据 / Games of Legends 公开时长',
        'sources':[
            {'name':'腾讯英雄联盟官方赛事数据平台','url':'https://lpl.qq.com/','fields':['schedule','duration','kills','winner','actual timestamps'],'maps':len(base['rows'])},
            {'name':'Riot Games 德玛西亚杯赛程与比赛数据','url':'https://lolesports.com/en-US/leagues/demacia_cup','fields':['schedule','participant kills','feed timestamps','patch'],'maps':len(extra['rows'])},
            {'name':'Games of Legends 德玛西亚杯逐局统计','url':extra['metadata']['duration_source_url'],'fields':['duration','winner','independent kill verification'],'maps':len(extra['rows'])},
        ],
        'fetchedAt':extra['metadata']['fetchedAt'],'cutoff':extra['metadata']['cutoff'],
        'historyAvailableThrough':max((r['available_at'] for r in rows),key=instant),
        'latestDate':rows[-1]['date'],
        'scope':'2026 腾讯官方列表已收录LPL、MSI、全球先锋赛和EWC，加Riot官方赛程中已结束的德玛西亚杯国际邀请赛；德杯时长来自Games of Legends。不代表全球全赛区覆盖。',
        'actual_completed_maps':len(rows),'completed_matches':len({r['series_id'] for r in rows}),
        'listed_completed_matches':base['metadata']['listed_completed_matches']+extra['metadata']['listed_completed_matches'],
        'expected_completed_maps':base['metadata']['expected_completed_maps']+extra['metadata']['expected_completed_maps'],
        'missing':base['metadata']['missing']+extra['metadata']['missing'],
        'complete':base['metadata']['complete'] and extra['metadata']['complete'],
        'demacia':extra['metadata'],
        'dataQualityNotes':extra['metadata']['dataQualityNotes'],
        'discrepancies':extra['metadata']['discrepancies'],
        'checks':base['metadata']['checks']+extra['metadata']['checks'],
        'limitations':[x for x in base['metadata']['limitations'] if '德玛西亚杯官方旧静态' not in x]+extra['metadata']['limitations'],
        'teamAliases':{**base['metadata']['teamAliases'],**extra['metadata']['teamAliases']},
    })
    metadata['competitions']=[c for c in base['metadata']['competitions'] if c['id']!='245']+[
        {'id':'117126995932274206','name':'Demacia Cup','listed_completed_matches':extra['metadata']['listed_completed_matches'],
         'expected_maps':extra['metadata']['expected_completed_maps'],'actual_maps':len(extra['rows'])}]
    coverage=[]
    for team in sorted({r[k] for r in rows for k in ('team_a','team_b')}):
        games=[r for r in rows if team in (r['team_a'],r['team_b'])]
        ids={r['team_a_id'] if team==r['team_a'] else r['team_b_id'] for r in games}
        coverage.append({'team':team,'team_ids':sorted(ids),'maps':len(games),'series':len({r['series_id'] for r in games}),
          'latestDate':max((r['date'] for r in games),key=instant),'tournaments':sorted({r['tournament'] for r in games})})
        metadata['teamAliases'][team]=team
    metadata['teamCoverage']=coverage
    snapshot={'rows':rows,'fixtures':base.get('fixtures',[])+extra.get('fixtures',[]),'metadata':metadata}
    output_path.parent.mkdir(parents=True,exist_ok=True)
    output_path.write_text(json.dumps(snapshot,ensure_ascii=False,indent=2))
    print(json.dumps({'rows':len(rows),'series':metadata['completed_matches'],'teams':len(coverage),'expected':metadata['expected_completed_maps'],'missing_series':len(metadata['missing']),'path':str(output_path)}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--base',type=pathlib.Path,default=ROOT/'cache'/'lol'/'tencent-data.json')
    p.add_argument('--demacia',type=pathlib.Path,default=ROOT/'cache'/'lol'/'demacia-data.json')
    p.add_argument('--output',type=pathlib.Path,default=ROOT/'dist'/'lol-data.json');a=p.parse_args()
    merge(a.base,a.demacia,a.output)

#!/usr/bin/env python3
"""Collect public Riot website completed schedule. Public persisted query and Apollo client headers, no account credentials.
Source: lolesports.com public JS manifest and client configuration captured 2026-10-08.
Event startTime is scheduled UTC, not actual game start. Never derive game duration or end from it.
"""
import argparse, json, pathlib, ssl, urllib.request, urllib.parse, datetime, time, concurrent.futures
ROOT=pathlib.Path(__file__).resolve().parent
LEAGUES={'LCK':('98767991310872058','lck'),'LEC':('98767991302996019','lec'),'LCS':('98767991299243165','lcs'),'LCP':('113476371197627891','lcp'),'CBLOL':('98767991332355509','cblol-brazil')}
HASH='7246add6f577cf30b304e651bf9e25fc6a41fe49aeafb0754c16b5778060fc0a'
HEADERS={'User-Agent':'Mozilla/5.0','Content-Type':'application/json','apollographql-client-name':'Esports Web','apollographql-client-version':'740a2d5'}
CTX=ssl.create_default_context(cafile='/etc/ssl/cert.pem' if pathlib.Path('/etc/ssl/cert.pem').exists() else None)
NOW=datetime.datetime.now(datetime.timezone.utc).isoformat()
YEAR=2026
AS_OF='2026-10-08T23:59:59.000Z'
REFRESH=True
def collect(item):
 league,(ident,slug)=item
 d=ROOT/'pages'/league; d.mkdir(parents=True,exist_ok=True)
 events={}; seen=set(); token=None; page=0
 while True:
  if page>=64:raise RuntimeError('Pagination limit exceeded; do not publish an incomplete schedule')
  v={'hl':'en-US','sport':['lol'],'leagues':[ident],'eventDateStart':f'{YEAR}-01-01T00:00:00.000Z','eventDateEnd':AS_OF,'eventState':['completed'],'eventType':'match','pageSize':40}
  if token:v['pageToken']=token
  qs={'operationName':'homeEvents','variables':json.dumps(v,separators=(',',':')),'extensions':json.dumps({'persistedQuery':{'version':1,'sha256Hash':HASH}},separators=(',',':'))}
  u='https://lolesports.com/api/gql?'+urllib.parse.urlencode(qs)
  path=d/f'{page:03}.json'
  if not REFRESH:b=path.read_bytes()
  else:
   with urllib.request.urlopen(urllib.request.Request(u,headers=HEADERS),context=CTX,timeout=45) as f:b=f.read()
   path.write_bytes(b)
  j=json.loads(b)
  if j.get('errors'):raise RuntimeError(str(j['errors']))
  es=j['data']['esports']
  for e in es['events']:
   if e['league']['id']!=ident:raise ValueError('Wrong league returned')
   if e['state']!='completed' or not e['startTime'].startswith(f'{YEAR}-'):raise ValueError('Wrong date/state returned')
   events[e['id']]=e
  token=es['pages']['newer']; page+=1
  print(league,page,len(events),'more' if token else 'end',flush=True)
  if not token:break
  if token in seen:raise RuntimeError('Repeated cursor')
  seen.add(token);time.sleep(.35)
 out={'league':league,'source_url':f'https://lolesports.com/en-US/leagues/{slug}','fetchedAt':NOW,'paginationExhausted':True,'pages':page,'series':list(events.values())}
 (ROOT/f'{league.lower()}-series.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
 return out
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--output-dir',type=pathlib.Path,default=ROOT)
 parser.add_argument('--year',type=int,default=2026)
 parser.add_argument('--as-of',default=datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),help='UTC ISO cutoff; only completed events are collected')
 mode=parser.add_mutually_exclusive_group()
 mode.add_argument('--refresh',action='store_true',help='Fetch all pages again (the default); never fall back to old cache on network error')
 mode.add_argument('--offline',action='store_true',help='Reparse a previously completed snapshot without fetching or advancing its observed time')
 args=parser.parse_args();ROOT=args.output_dir;ROOT.mkdir(parents=True,exist_ok=True);YEAR=args.year;AS_OF=args.as_of;REFRESH=not args.offline
 if args.offline:
  old=json.loads((ROOT/f'riot-series-{YEAR}.json').read_text())
  NOW=old['fetchedAt'];AS_OF=old.get('asOf',AS_OF)
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:all_results=list(pool.map(collect,LEAGUES.items()))
 output={'fetchedAt':NOW,'source':'https://lolesports.com/api/gql','notes':['startTime is scheduled UTC, not actual game start.','vod startMillis/endMillis are video timestamps, not game duration.','Public website persisted homeEvents query; client awareness headers do not authenticate an account.'],'coverage':{x['league']:{'series':len(x['series']),'maps':sum(sum(g['state']=='completed' for g in e['match']['games']) for e in x['series']),'paginationExhausted':x['paginationExhausted'],'pages':x['pages']} for x in all_results},'series':[e for x in all_results for e in x['series']]}
 output['year']=YEAR;output['asOf']=AS_OF
 (ROOT/f'riot-series-{YEAR}.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps(output['coverage']))

/** Credential-free adapter for the public endpoints used by Tencent's official UI. */
const API = 'https://prod.comp.smoba.qq.com/leaguesite';
const SOURCE = '腾讯王者荣耀官方赛事数据平台';
const SOURCE_URL = 'https://pvp.qq.com/matchdata/index.html';
const LEAGUE_IDS = ['20260001', '20260002', '20260003', '20260004'];
const TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const MAX_MATCHES_PER_LEAGUE = 1000;
const text = value => String(value ?? '');
const int = value => Number.isInteger(Number(value)) && value !== '' && value != null ? Number(value) : NaN;
const eventName = row => row.event || [row.season, row.stage].filter(Boolean).join(' · ');
const detailUrl = (league, match) => `https://pvp.qq.com/matchdata/scheduleDetails.html?league_id=${encodeURIComponent(league)}&match_id=${encodeURIComponent(match)}`;

/** Accepts the collector's raw snapshot or an already normalized snapshot. */
export function normalizeSnapshot(raw = {}) {
  return {
    ...raw,
    rows: (Array.isArray(raw.rows) ? raw.rows : []).map(row => ({
      ...row,
      id: text(row.id ?? row.game_id), series_id: text(row.series_id ?? row.match_id),
      date: row.date, available_at: row.available_at || undefined,
      season: '2026', event: eventName(row), patch: row.patch || '',
      team_a: row.team_a, team_b: row.team_b,
      map: Number(row.map ?? row.game_no), duration_sec: Number(row.duration_sec ?? row.duration_seconds),
      kills_a: Number(row.kills_a), kills_b: Number(row.kills_b), winner: row.winner,
      league_id: text(row.league_id), team_a_id: text(row.team_a_id), team_b_id: text(row.team_b_id),
      source_url: row.source_url, synthetic: false,
      verified: row.verified !== false && text(row.data_url).startsWith(`${API}/battle/open?battle_id=`),
    })),
    fixtures: (Array.isArray(raw.fixtures) ? raw.fixtures : []).map(row => ({
      ...row,
      id: text(row.id ?? row.match_id), date: row.date, event: eventName(row),
      teamA: row.teamA ?? row.team_a, teamB: row.teamB ?? row.team_b, bo: Number(row.bo),
      league_id: text(row.league_id), team_a_id: text(row.team_a_id), team_b_id: text(row.team_b_id),
      source_url: row.source_url,
    })),
    metadata: { ...(raw.metadata || {}) },
  };
}

function cancelled(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('同步已取消', 'AbortError');
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    cancelled(signal);
    const abort = () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new DOMException('同步已取消', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function request(route, params, signal) {
  const suffix = params ? `?${new URLSearchParams(params)}` : '';
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    cancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${API}/${route}${suffix}`, {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) throw new Error(`官方接口 HTTP ${response.status}`);
      const data = await response.json();
      if (Number(data.code) !== 200) throw new Error(`官方接口 code=${text(data.code)}`);
      return data;
    } catch (error) {
      cancelled(signal);
      lastError = error.name === 'AbortError' ? new Error('官方接口请求超时') : error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (attempt < MAX_ATTEMPTS - 1) await delay(400 * (attempt + 1), signal);
  }
  throw lastError;
}

async function pool(items, worker, signal) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (next < items.length) {
      cancelled(signal);
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function apiTime(value) {
  const raw = text(value);
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(' ', 'T') + '+08:00' : raw;
  if (!Number.isFinite(Date.parse(date))) throw new Error(`无效官方日期：${raw}`);
  return date;
}

function context(match, league) {
  const a = match.camp1, b = match.camp2;
  if (!a?.team_id || !b?.team_id || text(a.team_id) === text(b.team_id) || !a.team_name || !b.team_name) throw new Error('队伍标识缺失或重复');
  const bo = int(match.bo);
  if (![3, 5, 7, 9].includes(bo)) throw new Error(`不支持的官方赛制 BO${match.bo}`);
  return {
    match_id: text(match.match_id), date: apiTime(match.start_time),
    available_at: int(match.status) === 2 ? apiTime(match.end_time) : undefined,
    season: league.league_name,
    stage: match.match_stage_desc || '', team_a: a.team_name, team_b: b.team_name,
    team_a_id: text(a.team_id), team_b_id: text(b.team_id), bo,
    league_id: text(league.league_id), source_url: detailUrl(league.league_id, match.match_id),
  };
}

function isValidCached(row, ctx, cutoff) {
  return row.verified === true && row.synthetic === false && row.league_id === ctx.league_id &&
    row.series_id === ctx.match_id && row.team_a_id === ctx.team_a_id && row.team_b_id === ctx.team_b_id &&
    row.team_a === ctx.team_a && row.team_b === ctx.team_b && row.date === ctx.date &&
    row.id && Number.isInteger(row.map) && row.map >= 1 && row.map <= ctx.bo &&
    Number.isFinite(row.duration_sec) && row.duration_sec > 0 && row.duration_sec < 7200 &&
    Number.isInteger(row.kills_a) && row.kills_a >= 0 && Number.isInteger(row.kills_b) && row.kills_b >= 0 &&
    [ctx.team_a, ctx.team_b].includes(row.winner) && Date.parse(row.date) <= cutoff &&
    row.available_at === ctx.available_at && Number.isFinite(Date.parse(row.available_at)) &&
    Date.parse(row.available_at) >= Date.parse(row.date) && Date.parse(row.available_at) <= cutoff;
}

function cachedSeries(rows, ctx, match, expected, cutoff) {
  // Old verified snapshots did not store publication availability. Reconcile it
  // against this sync's official end time before validation, without refetching
  // all battle details or ever substituting scheduled start for actual end.
  rows = rows.map(row => ({ ...row, available_at: ctx.available_at }));
  if (rows.length !== expected || !rows.every(row => isValidCached(row, ctx, cutoff))) return null;
  if (new Set(rows.map(row => row.id)).size !== expected || new Set(rows.map(row => row.map)).size !== expected) return null;
  if (!rows.every(row => row.map <= expected)) return null;
  if (rows.filter(row => row.winner === ctx.team_a).length !== int(match.camp1.score) ||
      rows.filter(row => row.winner === ctx.team_b).length !== int(match.camp2.score)) return null;
  return rows;
}

function convertBattle(data, battle, ctx) {
  if (int(data.status) !== 2 || text(data.battle_id) !== text(battle.battle_id)) throw new Error('对局未结束或对局ID不符');
  const camps = [data.camp1, data.camp2];
  const aIndex = camps.findIndex(camp => text(camp?.team_id) === ctx.team_a_id);
  const bIndex = camps.findIndex(camp => text(camp?.team_id) === ctx.team_b_id);
  if (aIndex < 0 || bIndex < 0 || aIndex === bIndex) throw new Error('对局队伍与系列赛队伍不一致');
  const a = camps[aIndex], b = camps[bIndex];
  const duration = Number(data.game_duration) / 1000, ka = int(a.kill_num), kb = int(b.kill_num), seq = int(data.battle_seq);
  if (!(duration > 0 && duration < 7200) || !Number.isInteger(ka) || !Number.isInteger(kb) || Math.min(ka, kb) < 0) throw new Error('时长或击杀字段无效');
  if (!Number.isInteger(seq) || seq < 1 || seq > ctx.bo || seq !== int(battle.battle_seq)) throw new Error('局序字段无效');
  const winnerIndex = int(data.win_camp) - 1;
  if (![0, 1].includes(winnerIndex)) throw new Error('胜方字段无效');
  for (const camp of [a, b]) {
    const players = (data.battle_player_list || []).filter(player => text(player.team_id) === text(camp.team_id));
    if (players.length !== 5 || players.some(player => !Number.isInteger(int(player.kill_num))) ||
        players.reduce((sum, player) => sum + int(player.kill_num), 0) !== int(camp.kill_num)) throw new Error('队伍击杀与五名选手合计不一致');
  }
  return {
    ...ctx, game_id: text(data.battle_id), game_no: seq, duration_seconds: duration,
    kills_a: ka, kills_b: kb, winner: winnerIndex === aIndex ? ctx.team_a : ctx.team_b,
    team_a_side: aIndex === 0 ? 'blue' : 'red', team_b_side: bIndex === 0 ? 'blue' : 'red',
    data_url: `${API}/battle/open?battle_id=${encodeURIComponent(data.battle_id)}`, verified: true,
  };
}

/**
 * Incremental synchronization. Only the four verified 2026 KPL-type leagues are
 * read. Progress: { phase, message, completed, total, maps }. Throws when league
 * discovery fails or cancellation is requested; other failures are explicit in
 * metadata.missing and metadata.complete. No storage is changed by this module.
 */
export async function syncOfficial(existingSnapshot, { onProgress, signal } = {}) {
  const existing = normalizeSnapshot(existingSnapshot);
  const cutoff = Date.now(), syncedAt = new Date(cutoff).toISOString();
  const progress = update => { if (typeof onProgress === 'function') onProgress(update); };
  progress({ phase: 'leagues', message: '连接腾讯官方公开赛事数据', completed: 0, total: 4, maps: 0 });
  const discovery = await request('leagues/open', null, signal);
  if (!Array.isArray(discovery.results)) throw new Error('官方联赛列表格式发生变化，请保留现有数据稍后重试');
  const leagues = discovery.results.filter(league => int(league.year) === 2026 && league.league_type_name === 'kpl' && LEAGUE_IDS.includes(text(league.league_id)));
  const uniqueLeagues = [...new Map(leagues.map(league => [text(league.league_id), league])).values()];
  if (!uniqueLeagues.length) throw new Error('官方接口未返回已核验的2026年KPL赛事，现有数据未被修改');
  const missing = [], fixtures = [], jobs = [], coverage = [], retainedRows = [];
  let fetchedLists = 0;
  const retainLeague = id => {
    const candidates = existing.rows.filter(row => row.league_id === id && row.verified && Date.parse(row.date) <= cutoff);
    const available = candidates.filter(row => Number.isFinite(Date.parse(row.available_at)) &&
      Date.parse(row.available_at) >= Date.parse(row.date) && Date.parse(row.available_at) <= cutoff);
    retainedRows.push(...available);
    if (available.length !== candidates.length) missing.push({ league_id: id, reason: `${candidates.length - available.length} 局旧数据缺少已核验结束时间，暂不纳入训练` });
    fixtures.push(...existing.fixtures.filter(row => row.league_id === id && Date.parse(row.date) > cutoff).map(row => ({ ...row, stale: true })));
    const previous = existing.metadata.leagues?.find(league => text(league.id) === id);
    coverage.push({ ...(previous || { id, name: `2026赛事 ${id}`, completed_matches: 0, expected_maps: 0, upcoming_matches: 0 }), id, stale: true });
  };
  for (const id of LEAGUE_IDS) if (!uniqueLeagues.some(league => text(league.league_id) === id)) {
    missing.push({ league_id: id, reason: '官方联赛列表缺少此前已核验赛事，保留旧快照并标为未完成' });
    retainLeague(id);
  }
  await pool(uniqueLeagues, async league => {
    const id = text(league.league_id);
    try {
      const response = await request('matches/open', { league_id: id }, signal);
      if (!Array.isArray(response.results) || response.results.length > MAX_MATCHES_PER_LEAGUE) throw new Error('官方赛程结构或数量异常');
      const result = { id, name: league.league_name, completed_matches: 0, expected_maps: 0, upcoming_matches: 0 };
      const seen = new Set();
      for (const match of response.results) {
        try {
          if (!match.match_id || seen.has(text(match.match_id))) throw new Error('重复或缺少系列赛ID');
          seen.add(text(match.match_id));
          if (text(match.league_id) !== id) throw new Error('系列赛联赛ID不符');
          const start = apiTime(match.start_time);
          if (!start.startsWith('2026-')) continue;
          const status = int(match.status);
          if (status === 2 && Date.parse(apiTime(match.end_time)) <= cutoff && Date.parse(start) <= cutoff) {
            const ctx = context(match, league), expected = int(match.camp1.score) + int(match.camp2.score);
            if (!Number.isInteger(expected) || expected < 1 || expected > ctx.bo || Math.min(int(match.camp1.score), int(match.camp2.score)) < 0) throw new Error('系列赛比分字段无效');
            jobs.push({ match, ctx, expected });
            result.completed_matches++; result.expected_maps += expected;
          } else if (status === 0 && Date.parse(start) > cutoff) {
            fixtures.push(context(match, league)); result.upcoming_matches++;
          }
        } catch (error) { missing.push({ league_id: id, match_id: text(match.match_id), reason: error.message }); }
      }
      coverage.push(result);
    } catch (error) {
      cancelled(signal);
      missing.push({ league_id: id, reason: `赛程获取失败，保留旧快照：${error.message}` });
      retainLeague(id);
    }
    progress({ phase: 'schedules', message: `已读取 ${++fetchedLists}/${uniqueLeagues.length} 个赛事赛程`, completed: fetchedLists, total: uniqueLeagues.length, maps: retainedRows.length });
  }, signal);
  const bySeries = new Map();
  for (const row of existing.rows) {
    if (!bySeries.has(row.series_id)) bySeries.set(row.series_id, []);
    bySeries.get(row.series_id).push(row);
  }
  let processed = 0, mapCount = retainedRows.length, reused = 0;
  const groups = await pool(jobs, async ({ match, ctx, expected }) => {
    const reusedRows = cachedSeries(bySeries.get(ctx.match_id) || [], ctx, match, expected, cutoff);
    const rows = [];
    if (reusedRows) { rows.push(...reusedRows); reused++; }
    else {
      try {
        const response = await request('match/battles/open', { match_id: ctx.match_id }, signal);
        if (!Array.isArray(response.results) || response.results.length > 9) throw new Error('官方逐局列表格式或数量异常');
        const seen = new Set();
        for (const battle of response.results) {
          cancelled(signal);
          if (int(battle.status) !== 2) continue;
          const bid = text(battle.battle_id);
          try {
            if (!bid || seen.has(bid)) throw new Error('缺少或重复对局ID');
            seen.add(bid);
            const detail = await request('battle/open', { battle_id: bid }, signal);
            rows.push(convertBattle(detail.data, battle, ctx));
          } catch (error) {
            cancelled(signal);
            missing.push({ league_id: ctx.league_id, match_id: ctx.match_id, game_id: bid, reason: error.message });
          }
        }
      } catch (error) {
        cancelled(signal);
        missing.push({ league_id: ctx.league_id, match_id: ctx.match_id, reason: error.message });
      }
      const actual = rows.length;
      if (actual !== expected) missing.push({ match_id: ctx.match_id, expected_maps: expected, actual_maps: actual, reason: '已采集局数与官方系列赛比分不符' });
      if (actual === expected && rows.filter(row => row.winner === ctx.team_a).length !== int(match.camp1.score)) missing.push({ match_id: ctx.match_id, reason: '逐局胜方与官方系列赛比分不符' });
      if (new Set(rows.map(row => row.game_no)).size !== actual || rows.some(row => row.game_no > expected)) missing.push({ match_id: ctx.match_id, reason: '逐局序号重复或超出官方比分范围' });
    }
    mapCount += rows.length;
    progress({ phase: 'maps', message: `已校验 ${++processed}/${jobs.length} 场、${mapCount} 局`, completed: processed, total: jobs.length, maps: mapCount });
    return rows;
  }, signal);
  const normalized = normalizeSnapshot({ rows: [...retainedRows, ...groups.flat()], fixtures });
  const seenGames = new Set(), seenSeriesMaps = new Set();
  normalized.rows = normalized.rows.filter(row => {
    const seriesMap = `${row.series_id}:${row.map}`;
    if (seenGames.has(row.id) || seenSeriesMaps.has(seriesMap)) {
      missing.push({ match_id: row.series_id, game_id: row.id, reason: '重复对局已隔离' }); return false;
    }
    seenGames.add(row.id); seenSeriesMaps.add(seriesMap); return true;
  }).sort((a, b) => a.date.localeCompare(b.date) || a.series_id.localeCompare(b.series_id) || a.map - b.map);
  normalized.fixtures = [...new Map(normalized.fixtures.map(row => [row.id, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
  coverage.sort((a, b) => a.id.localeCompare(b.id));
  for (const league of coverage) league.actual_maps = normalized.rows.filter(row => row.league_id === league.id).length;
  const expected = coverage.reduce((sum, league) => sum + (Number(league.expected_maps) || 0), 0);
  normalized.metadata = {
    ...existing.metadata, year: 2026, syncedAt, fetchedAt: new Date().toISOString(), cutoff: syncedAt,
    source: SOURCE, sourceLabel: SOURCE, source_url: SOURCE_URL, source_api: API,
    source_script: 'https://pvp.qq.com/m/matchdata/js/league.js',
    leagues: coverage, completed_matches: coverage.reduce((sum, league) => sum + (Number(league.completed_matches) || 0), 0),
    expected_completed_maps: expected, actual_completed_maps: normalized.rows.length,
    count: normalized.rows.length, latestDate: normalized.rows.at(-1)?.date || null,
    reused_matches: reused, missing, complete: missing.length === 0 && expected === normalized.rows.length,
    scope: '2026年官方 league_type_name=kpl 的四项赛事（含挑战者杯）；仅截至同步开始时已结束的系列赛与对局。',
    checks: ['按team_id对齐每局阵营', '官方时长由毫秒转为秒', '队伍击杀与五名选手合计核对', '逐局胜方与系列赛比分核对', '已采集局数与官方比分核对', '全部对局以官方系列赛实际结束时间作为available_at'],
    limitations: ['公开接口无稳定性承诺，失败与缺失逐项列明。', '未来赛程可能调整；缓存赛程获取失败时明确标记stale。', '官网没有已核验版本或盘口字段；阈值由用户输入。'],
  };
  progress({ phase: 'done', message: missing.length ? `同步结束：${normalized.rows.length} 局，${missing.length} 项缺失或异常` : `同步完成：${normalized.rows.length} 局`, completed: jobs.length, total: jobs.length, maps: normalized.rows.length });
  return normalized;
}

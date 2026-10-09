/**
 * Per-game transparent statistical baseline. No external libraries or remote data.
 * Every demo observation is synthetic; importing a CSV never claims verification.
 */
export const schema = [
  { key: 'game', label: '游戏类型（kpl / lol；缺省为 kpl）', required: false, example: 'kpl', aliases: ['游戏', '游戏类型', 'game_type', 'game_code'] },
  { key: 'id', label: '记录ID', required: false, example: 'S001-1', aliases: ['记录id', '编号', 'map_id', 'game_id'] },
  { key: 'series_id', label: '系列赛ID', required: true, example: 'S001', aliases: ['系列赛id', '比赛id', 'match_id', 'series'] },
  { key: 'series_verified', label: '系列赛归属已核验', required: false, example: 'true', aliases: ['系列赛归属已核验'] },
  { key: 'series_complete', label: '系列赛记录完整', required: false, example: 'true', aliases: ['系列赛记录完整'] },
  { key: 'backtest_eligible', label: '可作历史回测目标', required: false, example: 'true', aliases: ['可作历史回测目标'] },
  { key: 'date', label: '比赛日期（无时区按北京时间 UTC+8）', required: true, example: '2026-03-01T20:00:00+08:00', aliases: ['比赛日期', '日期', '比赛时间', 'datetime', 'match_date'] },
  { key: 'available_at', label: '数据可用时间（推荐系列赛结束时间）', required: false, example: '2026-03-01T22:30:00+08:00', aliases: ['数据可用时间', '系列赛结束时间', 'series_end_time', 'end_time'] },
  { key: 'availability_basis', label: '数据可用时间依据', required: false, example: 'observed_snapshot', aliases: ['数据可用时间依据'] },
  { key: 'observed_at', label: '首次观测时间', required: false, example: '2026-10-08T15:00:00+08:00', aliases: ['首次观测时间'] },
  { key: 'date_basis', label: '比赛日期依据', required: false, example: 'unknown_timezone_upper_bound', aliases: ['比赛日期依据'] },
  { key: 'source_game_id', label: '来源逐局ID', required: false, example: '', aliases: ['来源逐局id'] },
  { key: 'source_date_raw', label: '来源原始日期文本', required: false, example: '', aliases: ['来源原始日期文本'] },
  { key: 'source_date', label: '来源日期', required: false, example: '', aliases: ['来源日期'] },
  { key: 'source_timezone', label: '来源时区', required: false, example: 'unknown', aliases: ['来源时区'] },
  { key: 'source_time_earliest', label: '可能最早UTC时刻', required: false, example: '', aliases: ['可能最早utc时刻'] },
  { key: 'source_time_latest', label: '可能最晚UTC时刻', required: false, example: '', aliases: ['可能最晚utc时刻'] },
  { key: 'season', label: '赛季年份', required: true, example: '2025', aliases: ['赛季', '赛季年份', '年份', 'year'] },
  { key: 'event', label: '赛事阶段', required: false, example: '春季赛', aliases: ['赛事', '阶段', '赛事阶段', 'tournament'] },
  { key: 'league_id', label: '赛事ID', required: false, example: '20260001', aliases: ['赛事id', '联赛id'] },
  { key: 'region', label: '赛区', required: false, example: 'LCK', aliases: ['赛区'] },
  { key: 'tournament_id', label: '赛事范围ID', required: false, example: 'lck', aliases: ['赛事范围id'] },
  ...['league', 'tournament', 'series_id_basis', 'series_source_url', 'riot_series_id', 'riot_game_id', 'series_mapping_evidence', 'official_tournament_id', 'official_tournament_name', 'scheduled_at', 'source_team_a', 'source_team_b', 'source_team_a_id', 'source_team_b_id', 'team_a_id', 'team_b_id', 'side_a', 'side_b', 'data_url', 'draft_data_url', 'draft_role_source', 'license', 'attribution'].map(key => ({ key, label: key, required: false, example: '', aliases: [] })),
  { key: 'source_url', label: '数据来源链接', required: false, example: 'https://pvp.qq.com/matchdata/index.html', aliases: ['数据来源链接', '来源链接', 'source'] },
  { key: 'duration_source_url', label: '时长来源链接', required: false, example: 'https://gol.gg/', aliases: ['时长来源链接', '时长来源'] },
  { key: 'kills_source_url', label: '击杀来源链接', required: false, example: 'https://lolesports.com/', aliases: ['击杀来源链接', '击杀来源'] },
  { key: 'lineup_a', label: 'A队英雄阵容JSON', required: false, example: '{"top":"KSante","jungle":"MonkeyKing","mid":"Ahri","bottom":"Varus","support":"Nautilus"}', aliases: ['a队英雄阵容json', 'a队阵容', '阵容a'] },
  { key: 'lineup_b', label: 'B队英雄阵容JSON', required: false, example: '', aliases: ['b队英雄阵容json', 'b队阵容', '阵容b'] },
  { key: 'draft_verified', label: '阵容记录已核验', required: false, example: 'true', aliases: ['阵容记录已核验', '阵容已核验'] },
  { key: 'draft_source_url', label: '阵容来源链接', required: false, example: 'https://lolesports.com/', aliases: ['阵容来源链接', '阵容来源'] },
  { key: 'patch', label: '游戏版本', required: false, example: '示例版本1', aliases: ['版本', '游戏版本', 'version'] },
  { key: 'team_a', label: 'A队', required: true, example: '成都AG超玩会', aliases: ['a队', '队伍a', '战队a', 'team a', 'teama'] },
  { key: 'team_b', label: 'B队', required: true, example: '重庆狼队', aliases: ['b队', '队伍b', '战队b', 'team b', 'teamb'] },
  { key: 'map', label: '局序', required: true, example: '1', aliases: ['局序', '第几局', '局数', 'game_number', 'game_no', 'map_number'] },
  { key: 'bo', label: '系列赛赛制（1 / 3 / 5 / 7 / 9）', required: false, example: '5', aliases: ['赛制', 'best_of', 'bestof', '系列赛赛制'] },
  { key: 'duration_sec', label: '时长（秒）', required: true, example: '1102', aliases: ['时长秒', '时长（秒）', '时长(秒)', 'duration_seconds', 'duration', '时长', '比赛时长'] },
  { key: 'kills_a', label: 'A队击杀', required: true, example: '14', aliases: ['a队击杀', 'a击杀', 'a队人头', '击杀a', 'team_a_kills', 'killa'] },
  { key: 'kills_b', label: 'B队击杀', required: true, example: '10', aliases: ['b队击杀', 'b击杀', 'b队人头', '击杀b', 'team_b_kills', 'killb'] },
  { key: 'winner', label: '本局胜方', required: false, example: '成都AG超玩会', aliases: ['本局胜方', '胜方', '获胜队伍', 'map_winner'] },
  { key: 'synthetic', label: '模拟数据标记', required: false, example: 'true', aliases: ['模拟数据标记', '模拟数据', 'is_synthetic'] },
];

const DAY = 86400000;
const METRICS = ['durationMin', 'killsA', 'killsB', 'totalKills', 'killDiff'];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const normalHeader = value => String(value).replace(/^\uFEFF/, '').trim().toLowerCase();
const finiteNumber = value => String(value ?? '').trim() === '' ? NaN : Number(value);
const normalizeGame = value => {
  const game = String(value ?? '').trim().toLowerCase();
  if (!game || ['kpl', '王者荣耀'].includes(game)) return 'kpl';
  if (['lol', '英雄联盟', 'league of legends'].includes(game)) return 'lol';
  return null;
};
const DRAFT_ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
const PROVENANCE_FIELDS = ['availability_basis', 'observed_at', 'date_basis', 'source_game_id', 'source_date_raw', 'source_date', 'source_timezone', 'source_time_earliest', 'source_time_latest', 'region', 'tournament_id', 'league', 'tournament', 'series_id_basis', 'series_source_url', 'riot_series_id', 'riot_game_id', 'series_mapping_evidence', 'official_tournament_id', 'official_tournament_name', 'scheduled_at', 'source_team_a', 'source_team_b', 'source_team_a_id', 'source_team_b_id', 'team_a_id', 'team_b_id', 'side_a', 'side_b', 'data_url', 'draft_data_url', 'draft_role_source', 'license', 'attribution'];

function validateChampionLineups(teamA, teamB) {
  const errors = [], lineups = {}, seen = new Set();
  for (const [side, source] of [['teamA', teamA], ['teamB', teamB]]) {
    const lineup = {};
    for (const role of DRAFT_ROLES) {
      const raw = source && typeof source === 'object' && !Array.isArray(source) ? source[role] : undefined;
      const champion = typeof raw === 'string' ? raw.trim() : '';
      if (!champion || !/^[A-Za-z][A-Za-z0-9]*$/.test(champion)) errors.push(`${side}.${role} 缺少有效英雄 ID`);
      else if (seen.has(champion.toLowerCase())) errors.push(`双方阵容包含重复英雄：${champion}`);
      else seen.add(champion.toLowerCase());
      lineup[role] = champion;
    }
    lineups[side] = lineup;
  }
  return { valid: errors.length === 0, errors, lineups };
}

function dateTimestamp(value) {
  const text = String(value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text);
  if (!match) return NaN;
  const [, year, month, day, hours = '00', minutes = '00', seconds = '00'] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day));
  if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1 || calendar.getUTCDate() !== +day || +hours > 23 || +minutes > 59 || +seconds > 59) return NaN;
  // KPL's local schedule uses Beijing time. Preserve explicit offsets, otherwise
  // consistently interpret both date-only and naive timestamps as UTC+08:00.
  const normalized = match[4] ? text.replace(' ', 'T') + (!match[8] ? '+08:00' : '') : `${text}T00:00:00+08:00`;
  return Date.parse(normalized);
}

function tokenizeCSV(text) {
  const rows = [];
  const errors = [];
  let row = [], cell = '', quoted = false, afterQuote = false;
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const finishCell = () => { row.push(cell); cell = ''; afterQuote = false; };
  const finishRow = () => { finishCell(); if (row.some(value => value.trim() !== '')) rows.push(row); row = []; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else cell += char;
      continue;
    }
    if (char === ',' ) { finishCell(); continue; }
    if (char === '\n' || char === '\r') { if (char === '\r' && source[i + 1] === '\n') i++; finishRow(); continue; }
    if (char === '"') {
      if (cell === '' && !afterQuote) quoted = true;
      else errors.push(`CSV 第 ${rows.length + 1} 行存在未转义的引号。`);
      continue;
    }
    if (afterQuote && char.trim() !== '') errors.push(`CSV 第 ${rows.length + 1} 行引号结束后存在多余字符。`);
    else if (!afterQuote) cell += char;
  }
  if (quoted) errors.push('CSV 中存在未闭合的双引号。');
  finishRow();
  return { rows, errors: [...new Set(errors)] };
}

export function parseCSV(text) {
  const parsed = tokenizeCSV(text);
  if (parsed.errors.length) return { rows: [], errors: parsed.errors, warnings: [] };
  if (!parsed.rows.length) return { rows: [], errors: ['CSV 文件为空。'], warnings: [] };
  const aliasMap = new Map();
  schema.forEach(field => [field.key, ...field.aliases].forEach(alias => aliasMap.set(normalHeader(alias), field.key)));
  const headers = parsed.rows[0].map(name => aliasMap.get(normalHeader(name)) || null);
  // Older CSV templates accepted a numeric `game` column as the map sequence.
  // Preserve that unambiguous form, while new templates use game=kpl/lol + map.
  if (!headers.includes('map') && parsed.rows.length > 1) {
    const legacyGame = parsed.rows[0].findIndex(name => normalHeader(name) === 'game');
    if (legacyGame >= 0 && parsed.rows.slice(1).every(row => /^[1-9]$/.test(String(row[legacyGame] ?? '').trim()))) headers[legacyGame] = 'map';
  }
  const recognized = headers.filter(Boolean);
  const errors = [];
  const warnings = [];
  for (const key of new Set(recognized)) if (recognized.filter(value => value === key).length > 1) errors.push(`字段 ${key} 重复，请保留一列。`);
  for (const field of schema) if (field.required && !headers.includes(field.key)) errors.push(`缺少必填列：${field.key}（${field.label}）。`);
  parsed.rows[0].forEach((name, index) => { if (!headers[index]) warnings.push(`未使用列：${name || '空列名'}。`); });
  if (errors.length) return { rows: [], errors, warnings };
  const raw = [];
  parsed.rows.slice(1).forEach((cells, index) => {
    if (cells.length !== headers.length) errors.push(`第 ${index + 2} 行有 ${cells.length} 列，表头为 ${headers.length} 列。`);
    else {
      const item = { _sourceLine: index + 2 };
      headers.forEach((key, column) => { if (key) item[key] = cells[column]; });
      raw.push(item);
    }
  });
  const validated = validateRows(raw);
  return { rows: validated.rows, errors: [...errors, ...validated.errors], warnings: [...warnings, ...validated.warnings] };
}

export function validateRows(input) {
  const rows = [], errors = [], warnings = [], ids = new Set(), seriesMaps = new Set();
  if (!Array.isArray(input)) return { rows, errors: ['数据必须为逐局记录数组。'], warnings };
  input.forEach((raw, index) => {
    const line = raw?._sourceLine || index + 1;
    const label = `第 ${line} 行`;
    if (!raw || typeof raw !== 'object') { errors.push(`${label}不是有效记录。`); return; }
    const row = {};
    schema.forEach(field => { row[field.key] = String(raw[field.key] ?? '').trim(); });
    const problems = [];
    for (const key of PROVENANCE_FIELDS) if (!row[key]) delete row[key];
    for (const key of ['series_verified', 'series_complete', 'backtest_eligible']) {
      const value = String(raw[key] ?? '').trim().toLowerCase();
      if (!value) delete row[key];
      else if (!['true', 'false', '1', '0', '是', '否'].includes(value)) problems.push(`${key} 必须为 true 或 false`);
      else row[key] = ['true', '1', '是'].includes(value);
    }
    if (row.series_verified === false) row.backtest_eligible = false;
    row.game = normalizeGame(row.game);
    if (!row.game) problems.push('游戏类型必须为 kpl（王者荣耀）或 lol（英雄联盟）');
    let hasLineup = false;
    for (const key of ['lineup_a', 'lineup_b']) {
      const value = raw[key];
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) { delete row[key]; continue; }
      hasLineup = true;
      if (typeof value === 'object' && !Array.isArray(value)) row[key] = value;
      else {
        try { row[key] = JSON.parse(value); }
        catch { problems.push(`${key} 不是有效 JSON`); delete row[key]; }
      }
    }
    const verifiedValue = String(raw.draft_verified ?? '').trim().toLowerCase();
    if (hasLineup || verifiedValue) {
      if (verifiedValue && !['true', 'false', '1', '0', '是', '否'].includes(verifiedValue)) problems.push('draft_verified 必须为 true 或 false');
      const checked = validateChampionLineups(row.lineup_a, row.lineup_b);
      row.draft_verified = ['true', '1', '是'].includes(verifiedValue) && checked.valid;
      if (checked.valid) { row.lineup_a = checked.lineups.teamA; row.lineup_b = checked.lineups.teamB; }
      else if (hasLineup || ['true', '1', '是'].includes(verifiedValue)) warnings.push(`${label}阵容不完整或英雄重复，已标记为不可用于阵容修正；基础逐局数据仍可使用。`);
    } else delete row.draft_verified;
    for (const field of schema) if (field.required && !row[field.key]) problems.push(`缺少${field.label}`);
    const timestamp = dateTimestamp(row.date);
    if (!Number.isFinite(timestamp)) problems.push('日期必须为有效 ISO 日期，如 2026-03-01 或 2026-03-01T20:00:00+08:00');
    if (row.available_at && (!Number.isFinite(dateTimestamp(row.available_at)) || dateTimestamp(row.available_at) < timestamp)) problems.push('数据可用时间必须为有效 ISO 时间，且不早于比赛日期');
    if (row.series_verified === false && !row.available_at) problems.push('系列赛归属未核验的逐局记录必须提供明确 available_at，不能按比赛日期近似');
    if (row.availability_basis === 'observed_snapshot') {
      if (!row.available_at || !Number.isFinite(dateTimestamp(row.observed_at)) || dateTimestamp(row.available_at) < dateTimestamp(row.observed_at)) problems.push('观测快照必须提供 observed_at，且 available_at 不早于首次观测时间');
    }
    for (const key of ['observed_at', 'source_time_earliest', 'source_time_latest']) if (row[key] && !Number.isFinite(dateTimestamp(row[key]))) problems.push(`${key} 必须为有效 ISO 时间`);
    if (row.date_basis === 'unknown_timezone_upper_bound' && (!row.source_time_earliest || !row.source_time_latest || dateTimestamp(row.source_time_earliest) > dateTimestamp(row.source_time_latest) || timestamp !== dateTimestamp(row.source_time_latest))) problems.push('未知时区记录必须保留最早/最晚时刻，并以最晚时刻作为内部日期上界');
    if (!/^\d{4}$/.test(row.season)) problems.push('赛季年份必须为四位数字，如 2026');
    else if (Number.isFinite(timestamp) && new Date(timestamp + 8 * 3600000).getUTCFullYear() !== Number(row.season)) problems.push('比赛日期的北京时间年份与赛季年份不一致');
    for (const key of ['source_date_raw', 'source_date']) if (row[key] && /^\d{4}-/.test(row[key]) && row[key].slice(0, 4) !== row.season) problems.push('来源原始日期年份与赛季年份不一致');
    if (row.team_a && row.team_a === row.team_b) problems.push('A 队与 B 队不能相同');
    row.map = finiteNumber(row.map);
    if (!Number.isInteger(row.map) || row.map < 1 || row.map > 9) problems.push('局序必须为 1–9 的整数');
    if (row.bo === '') delete row.bo;
    else {
      row.bo = finiteNumber(row.bo);
      if (![1, 3, 5, 7, 9].includes(row.bo)) problems.push('系列赛赛制 bo 必须为 1、3、5、7 或 9');
      else if (row.map > row.bo) problems.push('局序不能超过系列赛赛制 bo');
    }
    if (/^\d{1,3}:\d{2}$/.test(row.duration_sec)) {
      const [minutes, seconds] = row.duration_sec.split(':').map(Number);
      row.duration_sec = seconds < 60 ? minutes * 60 + seconds : NaN;
    } else row.duration_sec = finiteNumber(row.duration_sec);
    if (!Number.isFinite(row.duration_sec) || row.duration_sec < 60 || row.duration_sec > 10800) problems.push('时长必须为 60–10800 秒，或 分:秒 格式');
    for (const key of ['kills_a', 'kills_b']) {
      row[key] = finiteNumber(row[key]);
      if (!Number.isInteger(row[key]) || row[key] < 0 || row[key] > 200) problems.push(`${key} 必须为 0–200 的整数`);
    }
    if (row.winner.toUpperCase() === 'A') row.winner = row.team_a;
    if (row.winner.toUpperCase() === 'B') row.winner = row.team_b;
    if (row.winner && row.winner !== row.team_a && row.winner !== row.team_b) problems.push('胜方必须为 A、B 或对应队伍的完整名称');
    row.id ||= `${row.series_id}-${row.map}`;
    const gameId = `${row.game}\u0000${row.id}`;
    const seriesMap = `${row.game}\u0000${row.series_id}\u0000${row.map}`;
    if (ids.has(gameId)) problems.push(`记录 ID 重复：${row.id}`);
    if (seriesMaps.has(seriesMap)) problems.push(`系列赛 ${row.series_id} 的第 ${row.map} 局重复`);
    if (problems.length) { errors.push(`${label}：${problems.join('；')}。`); return; }
    row.synthetic = raw.synthetic === true || ['true', '1', '是'].includes(String(raw.synthetic ?? '').trim().toLowerCase());
    ids.add(gameId); seriesMaps.add(seriesMap); rows.push(row);
  });
  rows.sort((a, b) => dateTimestamp(a.date) - dateTimestamp(b.date) || a.series_id.localeCompare(b.series_id) || a.map - b.map);
  if (rows.length && !rows.some(row => row.winner)) warnings.push('未提供本局胜方；系统不会用击杀数推断比赛胜负。');
  return { rows, errors, warnings };
}

export const DEMO_TEAMS = ['成都AG超玩会', '重庆狼队', '北京WB', '佛山DRG', '武汉eStarPro', '广州TTG', '济南RW侠', '苏州KSG', '南京Hero久竞', '杭州LGD.NBW', '上海EDG.M', '长沙TES.A'];

export function generateDemo(seed = 20251008) {
  let state = Number(seed) >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) * Math.cos(2 * Math.PI * random());
  const rows = [];
  for (let week = 0; week < 52; week++) {
    const teamOrder = [...DEMO_TEAMS.keys()];
    for (let i = teamOrder.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [teamOrder[i], teamOrder[j]] = [teamOrder[j], teamOrder[i]]; }
    for (let fixture = 0; fixture < 3; fixture++) {
      const a = teamOrder[fixture * 2], b = teamOrder[fixture * 2 + 1];
      const base = Date.UTC(2025, 0, 3 + week * 7 + fixture, 11, 0);
      const seriesId = `DEMO-2025-${String(week * 3 + fixture + 1).padStart(3, '0')}`;
      let scoreA = 0, scoreB = 0;
      for (let map = 1; map <= 5 && scoreA < 3 && scoreB < 3; map++) {
        const formA = 1.8 * Math.sin(a * 1.1) + (5.5 - a) * 0.12;
        const formB = 1.8 * Math.sin(b * 1.1) + (5.5 - b) * 0.12;
        const activity = normal() * 1.7;
        const duration = clamp(18.1 + (a % 4 + b % 4 - 3) * 0.23 + Math.abs(formA - formB) * -0.16 + normal() * 2.45 + map * 0.09, 10, 31);
        const killsA = Math.round(clamp(12.2 + formA - formB * 0.25 + activity + normal() * 3.9 + (duration - 18) * 0.42, 0, 42));
        const killsB = Math.round(clamp(12.2 + formB - formA * 0.25 + activity + normal() * 3.9 + (duration - 18) * 0.42, 0, 42));
        // Synthetic objective outcome has independent noise; more kills need not mean a win.
        const winner = formA - formB + normal() * 3.5 > 0 ? DEMO_TEAMS[a] : DEMO_TEAMS[b];
        if (winner === DEMO_TEAMS[a]) scoreA++; else scoreB++;
        rows.push({ id: `${seriesId}-${map}`, series_id: seriesId, date: new Date(base + (map - 1) * 40 * 60000).toISOString(), season: '2025', event: week < 18 ? '模拟春季赛' : week < 37 ? '模拟夏季赛' : '模拟年度赛', patch: `模拟版本${Math.floor(week / 9) + 1}`, team_a: DEMO_TEAMS[a], team_b: DEMO_TEAMS[b], map, duration_sec: Math.round(duration * 60), kills_a: killsA, kills_b: killsB, winner, synthetic: true });
      }
    }
  }
  return rows.sort((a, b) => dateTimestamp(a.date) - dateTimestamp(b.date));
}

export function sampleCSV(rows = []) {
  const escape = value => {
    const serialized = value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    return /[",\r\n]/.test(serialized) ? `"${serialized.replace(/"/g, '""')}"` : serialized;
  };
  return '\uFEFF' + [schema.map(field => field.key).join(','), ...rows.map(row => schema.map(field => escape(row[field.key])).join(','))].join('\r\n');
}

function resolveOptions(options) {
  const lookbackValue = options.lookback === 'all' || options.lookback === 0 ? Infinity : Number(options.lookback ?? 90);
  return {
    ...options,
    game: normalizeGame(options.game),
    season: String(options.season ?? 'all'),
    map: options.map === undefined || options.map === 'all' ? 'all' : Number(options.map),
    lookback: [60, 90, 180, Infinity].includes(lookbackValue) ? lookbackValue : 90,
    durationLine: Number(options.durationLine ?? 18.5),
    killsLine: Number(options.killsLine ?? 24.5),
    handicap: Number(options.handicap ?? 0),
    excludeSeriesId: options.excludeSeriesId ?? options.seriesId ?? options.series_id,
  };
}

function eligibleHistory(rows, options, cutoff) {
  return rows.filter(row => {
    if ((row.series_verified === false || row.availability_basis === 'observed_snapshot') && (!row.available_at || !Number.isFinite(dateTimestamp(row.available_at)))) return false;
    const time = dateTimestamp(row.date);
    const available = dateTimestamp(row.available_at || row.date);
    if (row.availability_basis === 'observed_snapshot') {
      const observed = dateTimestamp(row.observed_at);
      if (!Number.isFinite(observed) || available < observed) return false;
    }
    return normalizeGame(row.game) === options.game && time < cutoff && available < cutoff && cutoff - time <= options.lookback * DAY &&
      (options.season === 'all' || String(row.season) === options.season) &&
      (options.map === 'all' || row.map === options.map) &&
      (!options.excludeSeriesId || row.series_id !== options.excludeSeriesId);
  });
}

// Share team evidence across map numbers. The requested map is an effect to
// estimate, not a reason to discard the team's other completed games.
function trainingHistory(rows, options, cutoff) {
  return eligibleHistory(rows, { ...options, map: 'all' }, cutoff);
}

function fitModel(history, cutoff, lookback) {
  const halfLife = Number.isFinite(lookback) ? lookback / 2 : 120;
  const weighted = history.map(row => ({ row, weight: Math.pow(0.5, (cutoff - dateTimestamp(row.date)) / DAY / halfLife) }));
  const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  const meanDuration = weighted.reduce((sum, item) => sum + item.weight * item.row.duration_sec / 60, 0) / weightSum;
  const meanKills = weighted.reduce((sum, item) => sum + item.weight * (item.row.kills_a + item.row.kills_b) / 2, 0) / weightSum;
  const teams = new Map();
  for (const { row, weight } of weighted) {
    for (const [name, opponent, own, conceded] of [[row.team_a, row.team_b, row.kills_a, row.kills_b], [row.team_b, row.team_a, row.kills_b, row.kills_a]]) {
      if (!teams.has(name)) teams.set(name, { attack: 0, defense: 0, pace: 0, observations: [], weight: 0, weightSq: 0 });
      const team = teams.get(name);
      team.observations.push({ opponent, own, conceded, duration: row.duration_sec / 60, weight });
      team.weight += weight; team.weightSq += weight * weight;
    }
  }
  // Coordinate updates fit regularized additive team effects. The ridge strength
  // is equivalent to 12 full-weight prior observations at the league average.
  const ridge = 12;
  for (let iteration = 0; iteration < 8; iteration++) {
    const next = new Map();
    for (const [name, team] of teams) {
      let attack = 0, defense = 0, pace = 0;
      for (const obs of team.observations) {
        const opponent = teams.get(obs.opponent);
        attack += obs.weight * (obs.own - meanKills - opponent.defense);
        defense += obs.weight * (obs.conceded - meanKills - opponent.attack);
        pace += obs.weight * (obs.duration - meanDuration - opponent.pace);
      }
      next.set(name, { attack: attack / (team.weight + ridge), defense: defense / (team.weight + ridge), pace: pace / (team.weight + ridge) });
    }
    for (const [name, value] of next) Object.assign(teams.get(name), value);
  }
  const mapEffects = new Map(), mapPrior = 40;
  const estimate = (teamA, teamB, map = 'all') => {
    const a = teams.get(teamA) || { attack: 0, defense: 0, pace: 0 };
    const b = teams.get(teamB) || { attack: 0, defense: 0, pace: 0 };
    const effect = mapEffects.get(map);
    const killOffset = (effect?.totalKills || 0) / 2;
    const killsA = clamp(meanKills + a.attack + b.defense + killOffset, 0, 200);
    const killsB = clamp(meanKills + b.attack + a.defense + killOffset, 0, 200);
    return { durationMin: clamp(meanDuration + a.pace + b.pace + (effect?.durationMin || 0), 1, 180), killsA, killsB, totalKills: killsA + killsB, killDiff: killsA - killsB };
  };
  for (const { row, weight } of weighted) {
    if (!mapEffects.has(row.map)) mapEffects.set(row.map, { count: 0, weight: 0, durationMin: 0, totalKills: 0 });
    const effect = mapEffects.get(row.map), baseline = estimate(row.team_a, row.team_b);
    effect.count++; effect.weight += weight;
    effect.durationMin += weight * (row.duration_sec / 60 - baseline.durationMin);
    effect.totalKills += weight * (row.kills_a + row.kills_b - baseline.totalKills);
  }
  for (const effect of mapEffects.values()) {
    effect.durationMin /= effect.weight + mapPrior;
    effect.totalKills /= effect.weight + mapPrior;
  }
  return { weighted, teams, weightSum, estimate, meanDuration, meanKills, halfLife, ridge, mapEffects, mapPrior };
}

function weightedQuantile(values, quantile) {
  const ordered = [...values].sort((a, b) => a.value - b.value);
  const target = ordered.reduce((sum, item) => sum + item.weight, 0) * quantile;
  let sum = 0;
  for (const item of ordered) { sum += item.weight; if (sum >= target) return item.value; }
  return ordered.at(-1)?.value ?? 0;
}

function market(samples, line, discrete) {
  const canPush = discrete && Number.isInteger(line);
  let over = 0.5, under = 0.5, push = canPush ? 0.5 : 0;
  for (const { value, weight } of samples) {
    if (value > line + 1e-9) over += weight;
    else if (value < line - 1e-9) under += weight;
    else if (canPush) push += weight;
    else { over += weight / 2; under += weight / 2; }
  }
  const sum = over + under + push;
  return { line, over: over / sum, under: under / sum, push: push / sum };
}

function forecastDistribution(model, rawMean, options) {
  const a = model.teams.get(options.teamA), b = model.teams.get(options.teamB);
  const hasMapEvidence = options.map !== 'all' && model.mapEffects.has(options.map);
  const residualScale = Math.sqrt(1 + 12 / (Math.min(a.weight, b.weight) + 12));
  const outcomes = Object.fromEntries(METRICS.map(key => [key, []]));
  for (const { row, weight } of model.weighted) {
    const estimate = model.estimate(row.team_a, row.team_b, hasMapEvidence ? row.map : 'all');
    const actual = { durationMin: row.duration_sec / 60, killsA: row.kills_a, killsB: row.kills_b, totalKills: row.kills_a + row.kills_b, killDiff: row.kills_a - row.kills_b };
    for (const key of METRICS) {
      const candidates = key === 'killDiff' ? [actual[key] - estimate[key], -(actual[key] - estimate[key])] : key === 'killsA' || key === 'killsB' ? [actual.killsA - estimate.killsA, actual.killsB - estimate.killsB] : [actual[key] - estimate[key]];
      // Both kill orientations enter the empirical distribution symmetrically.
      for (const residual of candidates) {
        let value = rawMean[key] + residual * residualScale;
        if (key !== 'killDiff') value = Math.max(key === 'durationMin' ? 1 : 0, value);
        if (key !== 'durationMin') value = Math.round(value);
        outcomes[key].push({ value, weight: weight / candidates.length });
      }
    }
  }
  const intervals = Object.fromEntries(METRICS.map(key => [key, [round(weightedQuantile(outcomes[key], 0.1)), round(weightedQuantile(outcomes[key], 0.9))]]));
  return { intervals, markets: { duration: market(outcomes.durationMin, options.durationLine, false), totalKills: market(outcomes.totalKills, options.killsLine, true), handicap: market(outcomes.killDiff, options.handicap, true) } };
}

export function predict(rows, input = {}) {
  const options = resolveOptions(input);
  const { teamA, teamB } = options;
  const cutoff = dateTimestamp(options.date);
  const empty = error => ({ available: false, game: options.game, error, sample: { league: 0, teamA: 0, teamB: 0, headToHead: 0, effective: 0, quality: 'low', qualityLabel: '数据不足' } });
  if (!options.game) return empty('游戏类型必须为 kpl 或 lol。');
  if (!teamA || !teamB || teamA === teamB) return empty('请选择两支不同的队伍。');
  if (options.map !== 'all' && (!Number.isInteger(options.map) || options.map < 1 || options.map > 9)) return empty('局序必须为 1–9 的整数，或全部局序。');
  if (!Number.isFinite(cutoff)) return empty('请选择有效的预测比赛日期。');
  if (![options.durationLine, options.killsLine, options.handicap].every(Number.isFinite)) return empty('预测阈值必须为有效数值。');
  const history = trainingHistory(rows, options, cutoff);
  if (!history.length) return empty('筛选范围内没有早于目标比赛的历史逐局数据。');
  const model = fitModel(history, cutoff, options.lookback);
  const a = model.teams.get(teamA), b = model.teams.get(teamB);
  if (!a || !b) return empty('至少一支队伍在筛选范围内没有历史数据，请扩大时间窗口或导入数据。');
  const rawMean = model.estimate(teamA, teamB, options.map);
  const effectiveA = a.weight * a.weight / a.weightSq;
  const effectiveB = b.weight * b.weight / b.weightSq;
  const effective = Math.min(effectiveA, effectiveB);
  const distribution = forecastDistribution(model, rawMean, options);
  const headToHead = history.filter(row => (row.team_a === teamA && row.team_b === teamB) || (row.team_a === teamB && row.team_b === teamA)).length;
  const minCount = Math.min(a.observations.length, b.observations.length);
  const mapCount = options.map === 'all' ? history.length : model.mapEffects.get(options.map)?.count || 0;
  const quality = mapCount < 12 ? 'low' : minCount >= 30 && effective >= 25 && history.length >= 150 ? 'high' : minCount >= 12 && effective >= 10 && history.length >= 60 ? 'medium' : 'low';
  const warnings = [];
  if (quality === 'low') warnings.push('战队或所选局序样本较少，预测不确定性较高。');
  if (options.map !== 'all' && mapCount < 30) warnings.push(`第 ${options.map} 局只有 ${mapCount} 条历史记录，局序修正向共享战队模型收缩；零样本时使用共享模型，以该局实际举行为条件。`);
  const syntheticCount = history.filter(row => row.synthetic).length;
  const availabilityCount = history.filter(row => row.available_at && Number.isFinite(dateTimestamp(row.available_at))).length;
  const observedSnapshotCount = history.filter(row => row.availability_basis === 'observed_snapshot').length;
  const unverifiedSeriesCount = history.filter(row => row.series_verified === false).length;
  const unknownTimezoneCount = history.filter(row => row.date_basis === 'unknown_timezone_upper_bound').length;
  const historyAvailableThrough = history.reduce((value, row) => dateTimestamp(row.available_at || row.date) > dateTimestamp(value) ? row.available_at || row.date : value, history[0].available_at || history[0].date);
  if (syntheticCount) warnings.push(`${syntheticCount} 条历史记录为模拟数据，结果仅用于体验功能。`);
  if (availabilityCount < history.length) warnings.push(`${history.length - availabilityCount} 条记录缺少数据可用时间，暂以提供的比赛时间近似；无法保证排除当时尚未结束的对局。`);
  if (observedSnapshotCount) warnings.push(`${observedSnapshotCount} 条记录仅从首次观测快照时刻起可用，未把该时间当作实际完赛时间。`);
  if (unverifiedSeriesCount) warnings.push(`${unverifiedSeriesCount} 条逐局记录尚未核验系列赛归属，不用于整场胜负统计或作为历史回测目标。`);
  if (unknownTimezoneCount) warnings.push(`${unknownTimezoneCount} 条记录的来源时区不明，内部日期仅采用保守最晚时刻计算近期权重。`);
  warnings.push('未纳入 BP、首发阵容及临场信息；跨版本数据可能影响表现。');
  if (options.game === 'lol') warnings.push('英雄联盟使用相同统计基线，未单独校准概率，也未控制赛区整体强弱；跨赛区比较需谨慎。');
  return {
    available: true,
    game: options.game,
    teamA, teamB, date: options.date,
    mean: Object.fromEntries(METRICS.map(key => [key, round(rawMean[key])])),
    ...distribution,
    sample: { league: history.length, requestedMap: options.map, mapCount, teamA: a.observations.length, teamB: b.observations.length, headToHead, effective: round(effective, 1), weightedTeamA: round(a.weight, 1), weightedTeamB: round(b.weight, 1), quality, qualityLabel: { low: '样本偏少', medium: '样本适中', high: '样本充足' }[quality] },
    model: { name: '时间衰减 · 共享战队 · 局序收缩', game: options.game, gameIsolation: '训练、残差和回测只使用所选游戏的数据', version: 'pooled-map-2.0', mapPooling: true, mapPriorMaps: model.mapPrior, mapEffect: options.map === 'all' ? null : model.mapEffects.get(options.map) || null, mapPolicy: '全部局序共享战队历史；指定局序对时长和总击杀拟合收缩残差偏移；无该局序记录时回退共享模型', halfLifeDays: model.halfLife, priorMaps: model.ridge, intervalLevel: 0.8, intervalMethod: '历史拟合残差经验分位数 + 小样本放宽；非置信区间，覆盖率需回测', probabilityMethod: '历史残差经验分布（0.5 平滑）；未做概率校准', historyFrom: history.reduce((v, row) => dateTimestamp(row.date) < dateTimestamp(v) ? row.date : v, history[0].date), historyTo: history.reduce((v, row) => dateTimestamp(row.date) > dateTimestamp(v) ? row.date : v, history[0].date), historyAvailableThrough, availabilityCoverage: availabilityCount / history.length, observedSnapshotCount, unverifiedSeriesCount, unknownTimezoneCount, availabilityPolicy: availabilityCount === history.length ? '全部训练记录仅在其数据可用时间之后使用' : '缺少 available_at 的记录使用 date 近似，未完全核验当时可用性', synthetic: syntheticCount > 0, syntheticCount, timezone: 'Asia/Shanghai', naiveDateTimezone: 'UTC+08:00', patchAware: false, regionStrengthAware: false, mapFilter: options.map, excludedSeriesId: options.excludeSeriesId || null, leakagePolicy: '比赛时间与数据可用时间均须严格早于目标时刻；已提供目标系列赛 ID 时排除该系列赛全部局数，回测始终排除同系列赛' },
    warnings,
  };
}

function backtestTargetEligible(row) {
  return row.backtest_eligible !== false && row.series_verified !== false && row.availability_basis !== 'observed_snapshot' && !['unknown_timezone_upper_bound', 'official_scheduled_series_start'].includes(row.date_basis);
}

export function backtest(rows, input = {}) {
  const options = resolveOptions(input);
  if (!options.game) return { available: false, game: null, count: 0, skipped: 0, error: '游戏类型必须为 kpl 或 lol。', details: [] };
  const limit = clamp(Math.floor(Number(input.limit) || 80), 1, 150);
  const minTeamSamples = Number(input.minTeamSamples ?? 6);
  const minLeagueSamples = Number(input.minLeagueSamples ?? 30);
  const cutoff = input.date ? dateTimestamp(input.date) : Infinity;
  const candidates = rows.filter(row => backtestTargetEligible(row) && normalizeGame(row.game) === options.game && dateTimestamp(row.date) < cutoff && dateTimestamp(row.available_at || row.date) < cutoff && (options.season === 'all' || String(row.season) === options.season) && (options.map === 'all' || row.map === options.map)).sort((a, b) => dateTimestamp(a.date) - dateTimestamp(b.date) || a.map - b.map);
  const details = [];
  let skipped = 0;
  // Only the latest requested maps are scored; each prediction trains afresh on
  // strictly earlier data and excludes every map of the target series.
  for (const row of candidates.slice(-limit)) {
    const prediction = predict(rows, { ...options, teamA: row.team_a, teamB: row.team_b, date: row.date, excludeSeriesId: row.series_id });
    if (!prediction.available || prediction.sample.league < minLeagueSamples || Math.min(prediction.sample.teamA, prediction.sample.teamB) < minTeamSamples) { skipped++; continue; }
    const actual = { durationMin: row.duration_sec / 60, killsA: row.kills_a, killsB: row.kills_b, totalKills: row.kills_a + row.kills_b, killDiff: row.kills_a - row.kills_b };
    details.push({ id: row.id, game: options.game, series_id: row.series_id, date: row.date, teamA: row.team_a, teamB: row.team_b, map: row.map, predicted: prediction.mean, actual, intervals: prediction.intervals, trainingCount: prediction.sample.league, trainingThrough: prediction.model.historyTo, trainingAvailableThrough: prediction.model.historyAvailableThrough, availabilityCoverage: prediction.model.availabilityCoverage });
  }
  if (!details.length) return { available: false, game: options.game, count: 0, skipped, error: '没有满足最低训练样本要求的历史比赛。', details: [] };
  const mae = {}, coverage80 = {};
  for (const key of METRICS) {
    mae[key] = round(details.reduce((sum, item) => sum + Math.abs(item.predicted[key] - item.actual[key]), 0) / details.length);
    coverage80[key] = details.filter(item => item.actual[key] >= item.intervals[key][0] && item.actual[key] <= item.intervals[key][1]).length / details.length;
  }
  return { available: true, game: options.game, mapScope: options.map, modelVersion: 'pooled-map-2.0', count: details.length, skipped, mae, coverage80, details, from: details[0].date, to: details.at(-1).date, synthetic: candidates.some(row => row.synthetic), methodology: '按时间滚动回测，只使用所选游戏并排除同一系列赛所有局；未核验系列归属、仅观测快照或明确不可回测的逐局记录不作评分目标；各局序共享战队历史，指定局序加入收缩偏移；每次至少 30 局共享样本且双方各 6 局。MAE 为平均绝对误差，覆盖率为实际值落入预测区间的比例。' };
}

// Shared model and distribution helpers keep the pre-match and draft paths aligned.
export const modelInternals = Object.freeze({ resolveOptions, dateTimestamp, eligibleHistory, trainingHistory, fitModel, forecastDistribution, weightedQuantile, market, validateChampionLineups, backtestTargetEligible, DRAFT_ROLES: Object.freeze([...DRAFT_ROLES]) });

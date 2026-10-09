import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Data URLs keep this standalone suite independent of package.json module type.
const source = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
const { generateDemo, parseCSV, validateRows, predict, backtest, sampleCSV, DEMO_TEAMS } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const demo = generateDemo();
const options = { teamA: DEMO_TEAMS[0], teamB: DEMO_TEAMS[1], date: '2026-01-01', season: '2025', lookback: 'all', durationLine: 18.5, killsLine: 24.5, handicap: 2.5 };

test('demo is deterministic, valid, annual, and explicitly synthetic', () => {
  assert.deepEqual(generateDemo(), demo);
  assert.ok(demo.length > 400);
  assert.equal(new Set(demo.flatMap(row => [row.team_a, row.team_b])).size, 12);
  assert.equal(new Set(demo.map(row => row.date.slice(5, 7))).size, 12);
  assert.ok(demo.every(row => row.synthetic === true));
  assert.equal(validateRows(demo).errors.length, 0);
  assert.ok(demo.some(row => row.kills_a > row.kills_b && row.winner === row.team_b));
});

test('CSV round trip retains simulation provenance and quoted fields', () => {
  const row = { ...demo[0], event: '模拟,赛事\n第二行 "引用"' };
  const result = parseCSV(sampleCSV([row]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows, [{ ...row, game: 'kpl', league_id: '', source_url: '', duration_source_url: '', kills_source_url: '', draft_source_url: '', available_at: '' }]);
  assert.equal(parseCSV(sampleCSV()).rows.length, 0);
  assert.equal(sampleCSV().split('\r\n').length, 1);
});

test('CSV backup preserves distinct duration and kills source links', () => {
  const row = { ...demo[0], duration_source_url: 'https://gol.gg/example-test-only', kills_source_url: 'https://lolesports.com/example-test-only' };
  const restored = parseCSV(sampleCSV([row]));
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.rows[0].duration_source_url, row.duration_source_url);
  assert.equal(restored.rows[0].kills_source_url, row.kills_source_url);
  assert.equal(restored.rows[0].synthetic, true);
});

test('regional provenance survives CSV and rejects unknown-series timing shortcuts or source-year mismatches', () => {
  const row = { ...demo[0], game: 'lol', date: '2025-03-01T12:00:00Z', available_at: '2026-01-02T00:00:00Z',
    series_verified: false, backtest_eligible: false, region: 'LCK', tournament_id: 'lck',
    source_game_id: 'synthetic-source-map', source_date_raw: '2025-03-01 00:00:00', source_date: '2025-03-01 00:00:00',
    source_timezone: 'unknown', source_time_earliest: '2025-02-28T10:00:00Z', source_time_latest: '2025-03-01T12:00:00Z',
    date_basis: 'unknown_timezone_upper_bound', availability_basis: 'observed_snapshot', observed_at: '2026-01-02T00:00:00Z' };
  const restored = parseCSV(sampleCSV([row]));
  assert.deepEqual(restored.errors, []);
  for (const key of ['series_verified', 'backtest_eligible', 'region', 'tournament_id', 'source_game_id', 'source_date_raw', 'source_date', 'source_timezone', 'source_time_earliest', 'source_time_latest', 'date_basis', 'availability_basis', 'observed_at']) assert.equal(restored.rows[0][key], row[key]);
  assert.match(validateRows([{ ...row, available_at: '' }]).errors.join(''), /available_at/);
  assert.match(validateRows([{ ...row, available_at: '2026-01-01T23:59:59Z' }]).errors.join(''), /首次观测/);
  assert.match(validateRows([{ ...row, source_date_raw: '2024-03-01 00:00:00' }]).errors.join(''), /来源原始日期年份/);
  assert.match(validateRows([{ ...row, date: '2025-03-01T10:00:00Z' }]).errors.join(''), /日期上界/);
  for (const key of ['series_verified', 'backtest_eligible']) assert.match(validateRows([{ ...row, [key]: 'sometimes' }]).errors.join(''), /必须为 true 或 false/);
  assert.equal(validateRows([{ ...row, backtest_eligible: true }]).rows[0].backtest_eligible, false);
});

test('observed snapshots only enter future training and never create unknown-series historical holdouts', () => {
  const history = demo.map(row => ({ ...row, game: 'lol' }));
  const unlinked = { ...history[0], id: 'UNLINKED-SYNTHETIC', series_id: 'UNLINKED-SYNTHETIC', series_verified: false, backtest_eligible: false,
    availability_basis: 'observed_snapshot', observed_at: '2026-01-02T00:00:00+08:00', available_at: '2026-01-02T00:00:00+08:00' };
  const input = { ...options, game: 'lol' };
  assert.deepEqual(predict([...history, unlinked], input), predict(history, input));
  const future = { ...input, date: '2026-01-03T00:00:00+08:00' };
  const baseline = predict(history, future), forecast = predict([...history, unlinked], future);
  assert.equal(forecast.sample.league, baseline.sample.league + 1);
  assert.equal(forecast.model.observedSnapshotCount, 1);
  assert.equal(forecast.model.unverifiedSeriesCount, 1);
  assert.match(forecast.warnings.join(''), /首次观测/);
  assert.deepEqual(predict([...history, { ...unlinked, available_at: undefined }], future), baseline);
  assert.deepEqual(predict([...history, { ...unlinked, observed_at: undefined }], future), baseline);
  assert.deepEqual(predict([...history, { ...unlinked, available_at: '2026-01-01T23:00:00+08:00' }], future), baseline);
  assert.deepEqual(backtest([...history, unlinked], { ...future, limit: 10 }), backtest(history, { ...future, limit: 10 }));
});

test('CSV recognizes Chinese aliases, mm:ss, optional winner, and valid zero kills', () => {
  const csv = '比赛ID,日期,年份,A队,B队,局序,时长,A队击杀,B队击杀,本局胜方\r\nS001,2025-03-01,2025,甲队,乙队,1,18:05,0,4,A';
  const result = parseCSV(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].duration_sec, 1085);
  assert.equal(result.rows[0].kills_a, 0);
  assert.equal(result.rows[0].winner, '甲队');
});

test('official game_id and game_no aliases map to map records', () => {
  const csv = 'game_id,match_id,date,season,team_a,team_b,game_no,duration_sec,kills_a,kills_b\nG1,S1,2026-01-15,2026,甲,乙,1,1080,12,10';
  const result = parseCSV(csv);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].id, 'G1');
  assert.equal(result.rows[0].map, 1);
});

test('game type is explicit for LoL imports and legacy numeric game columns stay compatible', () => {
  const csv = 'game_id,match_id,date,season,team_a,team_b,game,duration_sec,kills_a,kills_b\nG1,S1,2026-01-15,2026,甲,乙,1,1080,12,10';
  const legacy = parseCSV(csv);
  assert.deepEqual(legacy.errors, []);
  assert.equal(legacy.rows[0].game, 'kpl');
  assert.equal(legacy.rows[0].map, 1);
  const lol = parseCSV('游戏类型,' + csv.replace('game,duration_sec', 'map,duration_sec').replace('\nG1,', '\n英雄联盟,G1,'));
  assert.deepEqual(lol.errors, []);
  assert.equal(lol.rows[0].game, 'lol');
  const restored = parseCSV(sampleCSV(lol.rows));
  assert.equal(restored.rows[0].game, 'lol');
  assert.match(validateRows([{ ...demo[0], game: 'unknown-game' }]).errors.join(''), /游戏类型/);
});

test('record and series-map identities are namespaced by game', () => {
  const result = validateRows([demo[0], { ...demo[0], game: 'lol' }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map(row => row.game), ['kpl', 'lol']);
  assert.equal(validateRows([{ ...demo[0], game: 'lol' }, { ...demo[0], game: 'LOL' }]).rows.length, 1);
});

test('BO9 supports maps 8 and 9 in both imports and predictions', () => {
  const rows = [8, 9].map(map => ({ ...demo[0], id: `BO9-${map}`, series_id: 'BO9', map }));
  const valid = validateRows(rows);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.rows.map(row => row.map), [8, 9]);
  assert.deepEqual(parseCSV(sampleCSV(rows)).errors, []);
  for (const map of [8, 9]) {
    const prediction = predict(rows, { ...options, teamA: rows[0].team_a, teamB: rows[0].team_b, map });
    assert.equal(prediction.available, true);
    assert.equal(prediction.sample.league, 2);
    assert.equal(prediction.sample.mapCount, 1);
  }
  assert.equal(validateRows([{ ...rows[0], map: 10 }]).rows.length, 0);
  assert.equal(predict(rows, { ...options, map: 10 }).available, false);
});

test('optional BO format survives CSV backup while missing formats remain unknown', () => {
  for (const bo of [1, 3, 5, 7, 9]) {
    const restored = parseCSV(sampleCSV([{ ...demo[0], bo }]));
    assert.deepEqual(restored.errors, []);
    assert.equal(restored.rows[0].bo, bo);
  }
  assert.equal(parseCSV(sampleCSV([demo[0]])).rows[0].bo, undefined);
  assert.equal(validateRows([{ ...demo[0], bo: 2 }]).rows.length, 0);
  assert.equal(validateRows([{ ...demo[0], bo: 3, map: 4 }]).rows.length, 0);
});

test('CSV rejects malformed structure and missing required columns', () => {
  assert.equal(parseCSV('date,team_a\n2025-01-01,"unclosed').rows.length, 0);
  assert.match(parseCSV('date,team_a\n2025-01-01,甲队').errors.join(''), /缺少必填列/);
  const csv = sampleCSV([demo[0]]).replace(',series_id,', ',id,');
  assert.match(parseCSV(csv).errors.join(''), /重复/);
});

test('validation rejects impossible dates, negatives, fractions and duplicate series maps', () => {
  const invalids = [
    { ...demo[0], date: '2025-02-30' },
    { ...demo[0], kills_a: -1 },
    { ...demo[0], kills_b: 2.5 },
    { ...demo[0], duration_sec: '18:75' },
    { ...demo[0], team_b: demo[0].team_a },
    { ...demo[0], winner: '其他队' },
    { ...demo[0], season: '2026' },
    { ...demo[0], season: '2025春季赛' },
  ];
  for (const row of invalids) assert.equal(validateRows([row]).rows.length, 0);
  const duplicate = validateRows([demo[0], { ...demo[0], id: 'different-id' }]);
  assert.equal(duplicate.rows.length, 1);
  assert.match(duplicate.errors.join(''), /第 1 局重复/);
  const noWinner = validateRows([{ ...demo[0], winner: '' }]);
  assert.equal(noWinner.rows[0].winner, '');
  assert.match(noWinner.warnings.join(''), /不会用击杀数推断/);
});

test('season matches the actual Beijing calendar year, including timezone boundaries', () => {
  const row = { ...demo[0], date: '2025-12-31T20:00:00Z', season: '2026', league_id: '20260001', source_url: 'https://pvp.qq.com/matchdata/index.html' };
  assert.deepEqual(validateRows([row]).errors, []);
  assert.match(validateRows([{ ...row, season: '2025' }]).errors.join(''), /北京时间年份/);
  const restored = parseCSV(sampleCSV([row]));
  assert.equal(restored.rows[0].league_id, row.league_id);
  assert.equal(restored.rows[0].source_url, row.source_url);
});

test('future observations and same-series earlier maps never enter prediction', () => {
  const request = { ...options, date: '2025-09-15', lookback: 180 };
  const base = predict(demo, request);
  const future = demo.filter(row => row.date >= '2025-09-15').map(row => ({ ...row, kills_a: 199, kills_b: 0, duration_sec: 7000 }));
  assert.deepEqual(predict([...demo.filter(row => row.date < '2025-09-15'), ...future], request), base);
  const row = demo.at(-1);
  const withExclusion = predict(demo, { ...options, teamA: row.team_a, teamB: row.team_b, date: row.date, excludeSeriesId: row.series_id });
  const manuallyRemoved = predict(demo.filter(item => item.series_id !== row.series_id), { ...options, teamA: row.team_a, teamB: row.team_b, date: row.date, excludeSeriesId: row.series_id });
  assert.deepEqual(withExclusion, manuallyRemoved);
});

test('data is unavailable until its series finishes, even when its start is earlier', () => {
  const request = { ...options, date: '2025-09-15T20:00:00+08:00', lookback: 180 };
  const base = predict(demo, request);
  const poison = { ...demo[0], id: 'overlapping-series-1', series_id: 'overlapping-series', date: '2025-09-15T17:00:00+08:00', available_at: '2025-09-15T20:06:21+08:00', kills_a: 180, kills_b: 0, duration_sec: 7000 };
  assert.deepEqual(predict([...demo, poison], request), base);
  assert.deepEqual(predict([...demo, { ...poison, available_at: request.date }], request), base);
  assert.equal(predict([...demo, { ...poison, available_at: '2025-09-15T19:59:59+08:00' }], request).sample.league, base.sample.league + 1);
  assert.equal(validateRows([{ ...poison, available_at: '2025-09-15T16:00:00+08:00' }]).rows.length, 0);
  assert.match(base.model.availabilityPolicy, /近似/);
  assert.match(base.warnings.join(''), /缺少数据可用时间/);
});

test('swapping team orientation swaps kill means and mirrors the kill difference', () => {
  const original = predict(demo, options);
  const reverse = predict(demo, { ...options, teamA: options.teamB, teamB: options.teamA, handicap: -options.handicap });
  assert.equal(original.available, true);
  assert.equal(original.mean.killsA, reverse.mean.killsB);
  assert.equal(original.mean.killsB, reverse.mean.killsA);
  assert.equal(original.mean.killDiff, -reverse.mean.killDiff);
  assert.equal(original.mean.durationMin, reverse.mean.durationMin);
  assert.equal(original.mean.totalKills, reverse.mean.totalKills);
  assert.ok(Math.abs(original.markets.handicap.over - reverse.markets.handicap.under) < 1e-12);
  assert.deepEqual(original.intervals.killsA, reverse.intervals.killsB);
});

test('probabilities are bounded, exhaustive, with pushes only on integer kills lines', () => {
  const result = predict(demo, options);
  for (const market of Object.values(result.markets)) {
    assert.ok(market.over >= 0 && market.over <= 1);
    assert.ok(market.under >= 0 && market.under <= 1);
    assert.ok(market.push >= 0 && market.push <= 1);
    assert.ok(Math.abs(market.over + market.under + market.push - 1) < 1e-12);
  }
  assert.equal(result.markets.totalKills.push, 0);
  assert.equal(result.markets.handicap.push, 0);
  const integer = predict(demo, { ...options, killsLine: 24, handicap: 0 });
  assert.ok(integer.markets.totalKills.push > 0);
  assert.ok(integer.markets.handicap.push > 0);
  for (const [key, interval] of Object.entries(result.intervals)) {
    assert.ok(interval[0] <= interval[1]);
    assert.ok(interval.every(Number.isFinite));
    if (key !== 'killDiff') assert.ok(interval[0] >= 0);
  }
});

test('season, lookback and strict date filters retain pooled history with a separate requested-map count', () => {
  const request = { ...options, date: '2025-12-30', map: 1, lookback: 60 };
  const result = predict(demo, request);
  const cutoff = Date.parse(`${request.date}T00:00:00+08:00`);
  const expected = demo.filter(row => Date.parse(row.date) < cutoff && cutoff - Date.parse(row.date) <= 60 * 86400000);
  assert.equal(result.sample.league, expected.length);
  assert.equal(result.sample.mapCount, expected.filter(row => row.map === 1).length);
  assert.equal(result.sample.requestedMap, 1);
  assert.equal(predict(demo, { ...options, season: '2024' }).available, false);
  assert.equal(predict(demo, { ...options, teamA: '未知队伍' }).available, false);
  assert.equal(predict(demo, { ...options, date: '2025-02-30' }).available, false);
  assert.equal(predict(demo, { ...options, teamA: options.teamB }).available, false);
  assert.equal(predict([], options).available, false);
});

test('pooling other map numbers preserves same-series, availability and future-data exclusions', () => {
  const request = { ...options, date: '2025-09-15T20:00:00+08:00', lookback: 180, map: 1, excludeSeriesId: 'TARGET-SERIES' };
  const base = predict(demo, request);
  const poison = { ...demo[0], id: 'POISON', series_id: 'OTHER-SERIES', map: 5, date: '2025-09-15T17:00:00+08:00', available_at: '2025-09-15T19:59:59+08:00', kills_a: 180, kills_b: 0, duration_sec: 7000 };
  const excluded = [
    { ...poison, id: 'SAME-SERIES', series_id: request.excludeSeriesId },
    { ...poison, id: 'UNAVAILABLE', available_at: request.date },
    { ...poison, id: 'FUTURE', date: '2025-09-16T17:00:00+08:00', available_at: '2025-09-16T18:00:00+08:00' },
  ];
  assert.deepEqual(predict([...demo, ...excluded], request), base);
  const eligible = predict([...demo, poison], request);
  assert.equal(eligible.sample.league, base.sample.league + 1);
  assert.equal(eligible.sample.mapCount, base.sample.mapCount);
  assert.notDeepEqual(eligible.mean, base.mean);
});

test('an unseen map number falls back to the shared team estimate with low quality', () => {
  const shared = predict(demo, { ...options, map: 'all' });
  const unseen = predict(demo, { ...options, map: 9 });
  assert.equal(unseen.available, true);
  assert.equal(unseen.sample.league, shared.sample.league);
  assert.equal(unseen.sample.mapCount, 0);
  assert.equal(unseen.sample.quality, 'low');
  assert.equal(unseen.model.mapEffect, null);
  for (const key of ['mean', 'intervals', 'markets']) assert.deepEqual(unseen[key], shared[key]);
  assert.match(unseen.warnings.join(''), /第 9 局只有 0 条/);
});

test('map effects learn duration and total-kill direction while preserving team orientation', () => {
  // Both maps have the same matchup and timestamp, so only the planted map
  // effects can separate them. These observations are synthetic fixtures.
  const rows = Array.from({ length: 80 }, (_, i) => ({
    ...demo[0], id: `MAP-EFFECT-${i}`, series_id: `MAP-EFFECT-${i}`,
    date: '2025-12-15T12:00:00Z', available_at: '2025-12-15T13:00:00Z',
    team_a: 'Alpha', team_b: 'Beta', map: i % 2 + 1,
    duration_sec: i % 2 ? 1800 : 1200, kills_a: i % 2 ? 20 : 10, kills_b: i % 2 ? 15 : 5,
  }));
  const input = { ...options, teamA: 'Alpha', teamB: 'Beta', map: 1 };
  const first = predict(rows, input), second = predict(rows, { ...input, map: 2 });
  const shared = predict(rows, { ...input, map: 'all' });
  assert.equal(first.sample.league, rows.length);
  assert.equal(first.sample.mapCount, rows.length / 2);
  assert.ok(first.mean.durationMin < shared.mean.durationMin && shared.mean.durationMin < second.mean.durationMin);
  assert.ok(first.mean.totalKills < shared.mean.totalKills && shared.mean.totalKills < second.mean.totalKills);
  assert.ok(second.mean.durationMin - first.mean.durationMin < 10);
  assert.ok(second.mean.totalKills - first.mean.totalKills < 20);
  assert.equal(first.mean.killDiff, second.mean.killDiff);
  const reversed = predict(rows, { ...input, teamA: 'Beta', teamB: 'Alpha', handicap: -input.handicap });
  assert.equal(first.mean.durationMin, reversed.mean.durationMin);
  assert.equal(first.mean.totalKills, reversed.mean.totalKills);
  assert.equal(first.mean.killsA, reversed.mean.killsB);
  assert.equal(first.mean.killsB, reversed.mean.killsA);
  assert.equal(first.mean.killDiff, -reversed.mean.killDiff);
  assert.deepEqual(first.intervals.killsA, reversed.intervals.killsB);
  assert.ok(Math.abs(first.markets.handicap.over - reversed.markets.handicap.under) < 1e-12);
  const opposite = rows.map(row => ({ ...row, duration_sec: 3000 - row.duration_sec, kills_a: 30 - row.kills_a, kills_b: 20 - row.kills_b }));
  const oppositeFirst = predict(opposite, input), oppositeSecond = predict(opposite, { ...input, map: 2 });
  assert.ok(oppositeFirst.mean.durationMin > oppositeSecond.mean.durationMin);
  assert.ok(oppositeFirst.mean.totalKills > oppositeSecond.mean.totalKills);
});

test('naive timestamps and date-only cutoffs use Beijing time, preserving explicit offsets', () => {
  const rows = [
    { ...demo[0], id: 'TZ1', series_id: 'TZ1', team_a: '甲', team_b: '乙', date: '2026-01-01T15:59:59Z', season: '2026' },
    { ...demo[0], id: 'TZ2', series_id: 'TZ2', team_a: '甲', team_b: '乙', date: '2026-01-02 00:00:00', season: '2026' },
    { ...demo[0], id: 'TZ3', series_id: 'TZ3', team_a: '甲', team_b: '乙', date: '2026-01-02T00:00:01+08:00', season: '2026' },
  ];
  const request = { teamA: '甲', teamB: '乙', season: '2026', lookback: 'all', date: '2026-01-02' };
  const dateOnly = predict(rows, request);
  assert.equal(dateOnly.sample.league, 1);
  assert.equal(predict(rows, { ...request, date: '2026-01-02 00:00:00' }).sample.league, 1);
  assert.equal(predict(rows, { ...request, date: '2026-01-01T16:00:00Z' }).sample.league, 1);
  const later = predict(rows, { ...request, date: '2026-01-02 00:00:02' });
  assert.equal(later.sample.league, 3);
  assert.equal(later.model.historyTo, rows[2].date);
  assert.equal(later.model.historyFrom, rows[0].date);
  assert.equal(predict(rows, { ...request, date: '2026-01-02 00:00:02', seriesId: 'TZ2' }).sample.league, 2);
  assert.equal(predict(rows, { ...request, date: '2026-01-02T00:00:02.123456+08:00' }).sample.league, 3);
});

test('version labels are not falsely treated as measured patch effects', () => {
  const base = predict(demo, options);
  const changed = predict(demo.map(row => ({ ...row, patch: 'different patch label' })), options);
  assert.deepEqual(changed.mean, base.mean);
  assert.equal(base.model.patchAware, false);
  assert.match(base.warnings.join(''), /跨版本/);
});

test('rolling backtest uses only earlier series and independently reproduces one scored map', () => {
  const result = backtest(demo, { season: '2025', lookback: 180, limit: 40, date: '2025-12-01' });
  assert.equal(result.available, true);
  assert.ok(result.count > 15 && result.count <= 40);
  for (const item of result.details) {
    assert.ok(Date.parse(item.trainingThrough) < Date.parse(item.date));
    assert.ok(Date.parse(item.date) < Date.parse('2025-12-01'));
  }
  const item = result.details.at(-1);
  const independent = predict(demo.filter(row => row.series_id !== item.series_id && Date.parse(row.date) < Date.parse(item.date)), { teamA: item.teamA, teamB: item.teamB, date: item.date, season: '2025', lookback: 180 });
  assert.deepEqual(independent.mean, item.predicted);
  for (const value of Object.values(result.mae)) assert.ok(Number.isFinite(value) && value >= 0);
  for (const value of Object.values(result.coverage80)) assert.ok(value >= 0 && value <= 1);
});

test('backtest never scores a target whose result was unavailable at the evaluation cutoff', () => {
  const last = demo.at(-1);
  const withDelayedResult = demo.map(row => row.id === last.id ? { ...row, available_at: '2026-01-02T00:00:00+08:00' } : row);
  const result = backtest(withDelayedResult, { season: '2025', lookback: 180, limit: 10, date: '2026-01-01T00:00:00+08:00' });
  assert.equal(result.available, true);
  assert.ok(result.details.every(row => row.id !== last.id));
});

// Constructed LoL-shaped observations below are test fixtures, not real match data.
const lolFixtures = demo.map(row => ({ ...row, game: 'lol', id: `LOL-${row.id}`, series_id: `LOL-${row.series_id}`, duration_sec: row.duration_sec + 900, kills_a: row.kills_a + 8, kills_b: row.kills_b + 5 }));

test('default KPL numerical behavior stays unchanged and other games cannot influence predictions', () => {
  const kpl = predict(demo, options);
  assert.deepEqual(kpl.mean, { durationMin: 17.3, killsA: 12.12, killsB: 13.66, totalKills: 25.78, killDiff: -1.53 });
  assert.deepEqual(kpl.intervals, { durationMin: [13.75, 21.09], killsA: [5, 19], killsB: [7, 20], totalKills: [15, 36], killDiff: [-10, 7] });
  assert.deepEqual(predict([...demo, ...lolFixtures], options), kpl);
  assert.deepEqual(predict(demo, { ...options, game: 'kpl' }), kpl);
  assert.equal(kpl.model.game, 'kpl');
  const lolOnly = predict(lolFixtures, { ...options, game: 'lol' });
  assert.deepEqual(predict([...lolFixtures, ...demo], { ...options, game: 'lol' }), lolOnly);
  assert.equal(lolOnly.model.game, 'lol');
  assert.equal(lolOnly.model.regionStrengthAware, false);
  assert.match(lolOnly.warnings.join(''), /未单独校准概率/);
  assert.equal(predict(demo, { ...options, game: 'lol' }).available, false);
  assert.equal(predict([...demo, ...lolFixtures], { ...options, game: 'dota' }).available, false);
});

test('LoL can explicitly pool 2025 and 2026 while season filters still isolate calendar years', () => {
  const newer = lolFixtures.map(row => ({ ...row, id: `${row.id}-2026`, series_id: `${row.series_id}-2026`, date: row.date.replace('2025-', '2026-'), season: '2026' }));
  const all = [...lolFixtures, ...newer, ...demo];
  const request = { ...options, game: 'lol', date: '2027-01-01', season: 'all' };
  assert.equal(predict(all, request).sample.league, lolFixtures.length + newer.length);
  assert.equal(predict(all, { ...request, season: '2025' }).sample.league, lolFixtures.length);
  assert.equal(predict(all, { ...request, season: '2026' }).sample.league, newer.length);
  assert.deepEqual(validateRows([...lolFixtures, ...newer]).errors, []);
});

test('rolling backtests isolate both training data and scored targets by game', () => {
  const request = { game: 'lol', season: '2025', lookback: 180, limit: 12, date: '2025-12-01' };
  const base = backtest(lolFixtures, request);
  assert.equal(base.available, true);
  assert.equal(base.game, 'lol');
  assert.ok(base.details.every(row => row.game === 'lol' && row.id.startsWith('LOL-')));
  assert.deepEqual(backtest([...lolFixtures, ...demo], request), base);
  assert.equal(backtest(demo, request).available, false);
  assert.equal(backtest(demo, { ...request, game: 'unknown' }).available, false);
  const kplRequest = { ...request, game: 'kpl' };
  assert.deepEqual(backtest([...lolFixtures, ...demo], kplRequest), backtest(demo, kplRequest));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Standalone modules match the browser's ES module source without package setup.
const loadModule = async relative => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(relative, import.meta.url), 'utf8')).toString('base64')}`);
const { recentSeries, recentUnlinkedMaps } = await loadModule('../dist/recent.js');
const { normalizeSnapshot } = await loadModule('../dist/official.js');
const snapshot = normalizeSnapshot(JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8')));
const kplRows = snapshot.rows.filter(row => row.league_id !== '20260002');
const fixture = snapshot.fixtures.find(match => match.id === '2026100901');

test('each side receives its latest 20 full series, independently of the other side', () => {
  assert.ok(fixture);
  const pins = [
    {
      team: '重庆狼队', maps: 92, wins: 16, kills: [837, 533],
      ids: ['2026100503', '2026100303', '2026091201', '2026090401', '2026082901', '2026082303', '2026082203', '2026081603', '2026081503', '2026073103', '2026072802', '2026072603', '2026072403', '2026071803', '2026071202', '2026071001', '2026070502', '2026070303', '2026062803', '2026062003'],
      latest: { opponent: '上海EDG.M', score: [3, 1], maps: 4, kills: [38, 24], duration: 849 },
    },
    {
      team: '南通Hero久竞', maps: 84, wins: 9, kills: [713, 757],
      ids: ['2026100602', '2026100402', '2026100203', '2026082801', '2026082202', '2026082101', '2026081601', '2026081501', '2026073002', '2026072801', '2026072603', '2026072303', '2026071701', '2026071503', '2026070901', '2026070501', '2026070301', '2026062802', '2026062602', '2026062001'],
      latest: { opponent: '北京JDG', score: [0, 3], maps: 3, kills: [13, 48], duration: 2255 / 3 },
    },
  ];
  for (const pin of pins) {
    const matches = recentSeries(kplRows, { team: pin.team, date: fixture.date, excludeSeriesId: fixture.id });
    assert.equal(matches.length, 20);
    assert.deepEqual(matches.map(match => match.id), pin.ids);
    assert.equal(matches.reduce((sum, match) => sum + match.maps.length, 0), pin.maps);
    assert.equal(matches.filter(match => match.outcome === 'win').length, pin.wins);
    assert.equal(matches.filter(match => match.outcome === 'loss').length, 20 - pin.wins);
    assert.ok(matches.every(match => match.complete));
    assert.deepEqual([matches.reduce((sum, match) => sum + match.ownKills, 0), matches.reduce((sum, match) => sum + match.opponentKills, 0)], pin.kills);
    const latest = matches[0];
    assert.equal(latest.opponent, pin.latest.opponent);
    assert.deepEqual([latest.ownWins, latest.opponentWins], pin.latest.score);
    assert.equal(latest.maps.length, pin.latest.maps);
    assert.deepEqual([latest.ownKills, latest.opponentKills], pin.latest.kills);
    assert.equal(latest.averageDuration, pin.latest.duration);
    // The most recent 20 extend beyond the prediction's default 90-day window.
    assert.ok(Date.parse(matches.at(-1).date) < Date.parse(fixture.date) - 90 * 86400000);
    assert.deepEqual(recentSeries([...kplRows].reverse(), { team: pin.team, date: fixture.date }).map(match => match.id), pin.ids);
  }
});

const row = (series, map, overrides = {}) => ({
  id: `${series}-${map}`, series_id: series, season: '2026',
  date: '2026-03-01T17:00:00+08:00', available_at: '2026-03-01T19:00:00+08:00',
  team_a: '甲队', team_b: '乙队', map, bo: 3,
  kills_a: 10, kills_b: 5, duration_sec: 1000, winner: '甲队', ...overrides,
});
const options = { team: '甲队', date: '2026-03-02T17:00:00+08:00' };

test('map side swaps retain team-oriented kills and score, without changing source rows', () => {
  const rows = [
    row('swaps', 3, { kills_a: 14, kills_b: 8, winner: '甲队', duration_sec: 1200 }),
    row('swaps', 1, { kills_a: 15, kills_b: 6, winner: '甲队', duration_sec: 900 }),
    row('swaps', 2, { team_a: '乙队', team_b: '甲队', kills_a: 12, kills_b: 7, winner: '乙队', duration_sec: 1500 }),
  ];
  const original = structuredClone(rows);
  const [match] = recentSeries(rows, options);
  assert.deepEqual(rows, original);
  assert.deepEqual(match.maps.map(map => [map.map, map.ownKills, map.opponentKills, map.outcome]), [[1, 15, 6, 'win'], [2, 7, 12, 'loss'], [3, 14, 8, 'win']]);
  assert.deepEqual([match.ownWins, match.opponentWins, match.ownKills, match.opponentKills, match.averageDuration], [2, 1, 36, 26, 1200]);
  assert.equal(match.outcome, 'win');
  const [opponentView] = recentSeries(rows, { ...options, team: '乙队' });
  assert.deepEqual([opponentView.ownWins, opponentView.opponentWins, opponentView.ownKills, opponentView.opponentKills], [1, 2, 26, 36]);
  assert.equal(opponentView.outcome, 'loss');
});

test('partial or unverifiable imported records retain maps but never claim a series result', () => {
  const cases = [
    [row('missing-bo', 1, { bo: undefined }), row('missing-bo', 2, { bo: undefined })],
    [row('unfinished-bo5', 1, { bo: 5 }), row('unfinished-bo5', 2, { bo: 5 })],
    [row('missing-map', 1), row('missing-map', 3)],
    [row('unknown-winner', 1), row('unknown-winner', 2, { winner: '', kills_a: 50, kills_b: 0 })],
    [row('source-incomplete', 1, { series_complete: false }), row('source-incomplete', 2, { series_complete: false })],
  ];
  for (const rows of cases) {
    const [match] = recentSeries(rows, options);
    assert.equal(match.maps.length, rows.length);
    assert.equal(match.complete, false);
    assert.equal(match.outcome, 'unknown');
  }
  const [unknown] = recentSeries(cases[3], options);
  assert.deepEqual([unknown.ownWins, unknown.opponentWins, unknown.allWinnersKnown], [1, 0, false]);
  assert.equal(unknown.maps[1].outcome, 'unknown');
});

test('a series is excluded as a whole if any map result is unavailable at the target time', () => {
  const rows = [
    row('completed', 1), row('completed', 2),
    row('exact-cutoff', 1), row('exact-cutoff', 2, { available_at: options.date }),
    row('future-result', 1), row('future-result', 2, { available_at: '2026-03-02T17:00:01+08:00' }),
    row('future-map', 1), row('future-map', 2, { date: options.date, available_at: options.date }),
    row('target-series', 1), row('target-series', 2),
  ];
  const matches = recentSeries(rows, { ...options, excludeSeriesId: 'target-series' });
  assert.deepEqual(matches.map(match => match.id), ['completed']);
  assert.equal(matches[0].maps.length, 2);
});

test('naive timestamps and date-only cutoffs use Beijing time and strict cutoff equality', () => {
  const rows = [
    row('earlier', 1, { bo: 1, date: '2026-03-01T15:59:58Z', available_at: '2026-03-01 23:59:59' }),
    row('equal', 1, { bo: 1, date: '2026-03-01 23:59:59', available_at: '2026-03-02T00:00:00' }),
    row('later', 1, { bo: 1, date: '2026-03-02T00:00:01+08:00', available_at: undefined }),
  ];
  for (const date of ['2026-03-02', '2026-03-02 00:00:00', '2026-03-01T16:00:00Z']) {
    assert.deepEqual(recentSeries(rows, { team: '甲队', date }).map(match => match.id), ['earlier']);
  }
  assert.deepEqual(recentSeries(rows, { team: '甲队', date: '2026-03-02 00:00:02' }).map(match => match.id), ['later', 'equal', 'earlier']);
});

test('fewer than 20 available series are not padded and unrelated or malformed groups stay out', () => {
  const rows = [
    row('valid', 1), row('valid', 2),
    row('unrelated', 1, { team_a: '丙队', team_b: '丁队', winner: '丙队' }),
    row('mixed-opponents', 1), row('mixed-opponents', 2, { team_b: '丙队' }),
  ];
  assert.deepEqual(recentSeries(rows, options).map(match => match.id), ['valid']);
  assert.deepEqual(recentSeries([], options), []);
  assert.deepEqual(recentSeries(rows, { ...options, team: '未知战队' }), []);
  assert.deepEqual(recentSeries(rows, { ...options, date: 'invalid' }), []);
});

test('unlinked maps remain separate, never fill the 20-series quota, and require explicit availability', () => {
  const verified = Array.from({ length: 22 }, (_, i) => row(`verified-${i}`, 1, { bo: 1 }));
  const unlinked = Array.from({ length: 25 }, (_, i) => row(`unlinked-${i}`, 1, { bo: 1, series_verified: false,
    date: '2026-03-02T10:00:00+08:00', available_at: '2026-03-02T12:00:00+08:00', source_date_raw: '2026-03-02 01:00:00' }));
  const all = [...verified, ...unlinked];
  const before = structuredClone(all);
  assert.deepEqual(recentSeries(all, options), recentSeries(verified, options));
  assert.equal(recentSeries(all, options).length, 20);
  const maps = recentUnlinkedMaps(all, { ...options, limit: 20 });
  assert.equal(maps.length, 20);
  assert.ok(maps.every(map => map.seriesVerified === false && map.recordType === 'map' && map.source_date_raw === '2026-03-02 01:00:00'));
  assert.equal(recentUnlinkedMaps(all, { ...options, date: '2026-03-02T12:00:00+08:00' }).length, 0);
  assert.equal(recentUnlinkedMaps(unlinked.map(map => ({ ...map, available_at: undefined })), options).length, 0);
  assert.equal(recentUnlinkedMaps(all, { ...options, excludeSeriesId: maps[0].series_id, limit: 25 }).length, 24);
  const reverse = recentUnlinkedMaps(all, { ...options, team: '乙队' });
  assert.equal(reverse[0].ownKills, maps[0].opponentKills);
  assert.equal(reverse[0].opponentKills, maps[0].ownKills);
  assert.deepEqual(all, before);
});

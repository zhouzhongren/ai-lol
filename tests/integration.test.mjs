import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const loadModule = async relative => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(relative, import.meta.url), 'utf8')).toString('base64')}`);
const engine = await loadModule('../dist/engine.js');
const official = await loadModule('../dist/official.js');
const raw = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
const snapshot = official.normalizeSnapshot(raw);
const kplRows = snapshot.rows.filter(row => row.league_id !== '20260002');
const cutoff = snapshot.metadata.cutoff || snapshot.metadata.fetchedAt;

test('official snapshot is complete, unique, 2026-only, non-synthetic and normalized', () => {
  const validated = engine.validateRows(snapshot.rows);
  assert.deepEqual(validated.errors, []);
  assert.equal(validated.rows.length, snapshot.rows.length);
  assert.ok(snapshot.rows.length >= 1392);
  assert.equal(snapshot.rows.length, snapshot.metadata.actual_completed_maps);
  assert.equal(snapshot.rows.length, snapshot.metadata.expected_completed_maps);
  assert.equal(snapshot.metadata.complete, true);
  assert.deepEqual(snapshot.metadata.missing, []);
  assert.equal(new Set(snapshot.rows.map(row => row.id)).size, snapshot.rows.length);
  assert.equal(new Set(snapshot.rows.map(row => `${row.series_id}:${row.map}`)).size, snapshot.rows.length);
  for (const row of snapshot.rows) {
    assert.equal(row.synthetic, false);
    assert.equal(row.verified, true);
    assert.equal(row.season, '2026');
    assert.ok(Date.parse(row.date) <= Date.parse(cutoff));
    assert.ok(Date.parse(row.available_at) >= Date.parse(row.date));
    assert.ok(Date.parse(row.available_at) <= Date.parse(cutoff));
    assert.ok([row.team_a, row.team_b].includes(row.winner));
    assert.match(row.data_url, /^https:\/\/prod\.comp\.smoba\.qq\.com\/leaguesite\/battle\/open\?battle_id=/);
  }
  assert.deepEqual(official.normalizeSnapshot(snapshot), snapshot);
});

test('three official maps pin units, side alignment, outcome and BO9 eighth map', () => {
  const pins = [
    { id: '48251408_30_1768371100', map: 1, duration: 944, a: '武汉eStarPro', b: '北京JDG', ka: 16, kb: 2, winner: '武汉eStarPro', sideA: 'red' },
    { id: '1373651472_27_1779541129', map: 8, duration: 1106, a: '成都AG超玩会', b: '重庆狼队', ka: 2, kb: 12, winner: '重庆狼队', sideA: 'blue' },
    { id: '1054884368_117_1791383435', map: 5, duration: 1172, a: '成都AG超玩会', b: '杭州LGD.NBW', ka: 3, kb: 10, winner: '杭州LGD.NBW', sideA: 'red' },
  ];
  for (const pin of pins) {
    const row = snapshot.rows.find(item => item.id === pin.id);
    assert.ok(row, `Missing verified map ${pin.id}`);
    assert.deepEqual([row.map, row.duration_sec, row.team_a, row.team_b, row.kills_a, row.kills_b, row.winner, row.team_a_side], [pin.map, pin.duration, pin.a, pin.b, pin.ka, pin.kb, pin.winner, pin.sideA]);
  }
});

test('all official upcoming fixtures produce finite bounded forecasts without future data', t => {
  assert.equal(snapshot.fixtures.length, snapshot.metadata.leagues.reduce((sum, league) => sum + league.upcoming_matches, 0));
  assert.ok(snapshot.fixtures.length > 0);
  const started = performance.now();
  for (const fixture of snapshot.fixtures) {
    assert.ok(Date.parse(fixture.date) > Date.parse(cutoff));
    for (const map of ['all', 1]) {
      const prediction = engine.predict(kplRows, { teamA: fixture.teamA, teamB: fixture.teamB, date: fixture.date, season: '2026', lookback: 90, map, excludeSeriesId: fixture.id, durationLine: 18.5, killsLine: 24.5, handicap: 3.5 });
      assert.equal(prediction.available, true, `${fixture.id}, map=${map}: ${prediction.error}`);
      assert.equal(prediction.model.synthetic, false);
      assert.ok(Date.parse(prediction.model.historyTo) < Date.parse(fixture.date));
      assert.equal(prediction.model.availabilityCoverage, 1);
      assert.ok(Date.parse(prediction.model.historyAvailableThrough) < Date.parse(fixture.date));
      assert.ok(Object.values(prediction.mean).every(Number.isFinite));
      assert.ok(prediction.mean.durationMin > 0);
      assert.ok(prediction.mean.killsA >= 0 && prediction.mean.killsB >= 0);
      assert.ok(Math.abs(prediction.mean.killsA + prediction.mean.killsB - prediction.mean.totalKills) <= 0.011);
      for (const interval of Object.values(prediction.intervals)) assert.ok(interval.every(Number.isFinite) && interval[0] <= interval[1]);
      for (const market of Object.values(prediction.markets)) {
        assert.ok([market.over, market.under, market.push].every(value => value >= 0 && value <= 1));
        assert.ok(Math.abs(market.over + market.under + market.push - 1) < 1e-12);
      }
    }
  }
  t.diagnostic(`${snapshot.fixtures.length} fixtures × 2 map scopes: ${(performance.now() - started).toFixed(0)} ms`);
});

test('real rolling backtest independently reproduces training cutoff and excludes target series', t => {
  const started = performance.now();
  const result = engine.backtest(kplRows, { season: '2026', lookback: 90, limit: 80, date: cutoff });
  assert.equal(result.available, true);
  assert.equal(result.count, 80);
  for (const scored of result.details) {
    assert.ok(Date.parse(scored.trainingThrough) < Date.parse(scored.date));
    assert.ok(Date.parse(scored.trainingAvailableThrough) < Date.parse(scored.date));
    assert.equal(scored.availabilityCoverage, 1);
    assert.ok(Date.parse(scored.date) < Date.parse(cutoff));
  }
  // Rebuild one holdout from physically pruned history rather than relying on
  // the engine's filtering: the output must remain exactly reproducible.
  const target = result.details.at(-1);
  const history = kplRows.filter(row => Date.parse(row.date) < Date.parse(target.date) && Date.parse(row.available_at) < Date.parse(target.date) && row.series_id !== target.series_id);
  const expected = engine.predict(history, { teamA: target.teamA, teamB: target.teamB, date: target.date, season: '2026', lookback: 90 });
  assert.deepEqual(expected.mean, target.predicted);
  assert.equal(expected.sample.league, target.trainingCount);
  assert.ok(Object.values(result.mae).every(value => Number.isFinite(value) && value >= 0));
  assert.ok(Object.values(result.coverage80).every(value => value >= 0 && value <= 1));
  t.diagnostic(`80 real holdouts: ${(performance.now() - started).toFixed(0)} ms; MAE=${JSON.stringify(result.mae)}`);
});

test('CSV backup preserves league scope, official trace links and real-data provenance', () => {
  const restored = engine.parseCSV(engine.sampleCSV(snapshot.rows));
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.rows.length, snapshot.rows.length);
  assert.equal(restored.rows.filter(row => row.league_id === '20260002').length, 188);
  assert.equal(restored.rows.filter(row => row.league_id !== '20260002').length, kplRows.length);
  assert.ok(restored.rows.every(row => row.synthetic === false && row.source_url.startsWith('https://pvp.qq.com/')));
  assert.ok(restored.rows.every(row => Number.isFinite(Date.parse(row.available_at))));
});

test('overlapping official series is excluded until actual series end time', () => {
  const target = snapshot.rows.find(row => row.series_id === '2026011403');
  const overlapping = snapshot.rows.filter(row => row.series_id === '2026011402');
  assert.ok(overlapping.length > 0);
  assert.ok(overlapping.every(row => Date.parse(row.date) < Date.parse(target.date) && Date.parse(row.available_at) > Date.parse(target.date)));
  // Those squads have no earlier 2026 sample. If start times alone leaked the
  // overlapping match into training, this request would incorrectly be available.
  const unavailable = engine.predict(overlapping, { teamA: overlapping[0].team_a, teamB: overlapping[0].team_b, date: target.date, season: '2026', lookback: 'all' });
  assert.equal(unavailable.available, false);
});

test('official adapter rejects cancelled synchronization before fetching', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled by integration test'));
  await assert.rejects(() => official.syncOfficial(snapshot, { signal: controller.signal }), /cancelled by integration test/);
});

test('official adapter fails closed on unrecognized discovery and leaves existing data untouched', async t => {
  const before = JSON.stringify(snapshot);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ code: 200, results: [{ league_id: '20270001', year: 2027, league_type_name: 'kpl' }] }) }));
  await assert.rejects(() => official.syncOfficial(snapshot), /未返回已核验的2026年KPL赛事/);
  assert.equal(JSON.stringify(snapshot), before);
});

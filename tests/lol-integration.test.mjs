import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const loadModule = async path => import(`data:text/javascript;base64,${Buffer.from(await readFile(new URL(path, import.meta.url), 'utf8')).toString('base64')}`);
const readJSON = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const engine = await loadModule('../dist/engine.js');
const games = await loadModule('../dist/games.js');
const official = await loadModule('../dist/official.js');
const { recentSeries, recentUnlinkedMaps } = await loadModule('../dist/recent.js');
const raw = await readJSON('../dist/lol-data.json');
const events = await readJSON('../dist/lol-events.json');
const snapshot = games.normalizeLolSnapshot(raw);
const schedule = games.normalizeLolSnapshot({ tournaments: events.tournaments, fixtures: events.fixtures });
const kpl = official.normalizeSnapshot(await readJSON('../dist/data.json'));
const cutoff = snapshot.metadata.cutoff || snapshot.metadata.fetchedAt;
const rows = games.rowsForGame(snapshot.rows, 'lol');
const regionalRows = rows.filter(row => row.id.startsWith('lol-chaincc-'));
const legacyRows = rows.filter(row => !row.id.startsWith('lol-chaincc-'));
const beijingYear = date => new Date(Date.parse(date) + 8 * 3600000).getUTCFullYear();
const latest = [...legacyRows].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || b.map - a.map)[0];
const historicalRequest = { game: 'lol', teamA: latest.team_a, teamB: latest.team_b, date: latest.date, excludeSeriesId: latest.series_id, season: '2026', lookback: 90, durationLine: 32.5, killsLine: 26.5, handicap: 3.5 };

test('LoL source snapshot validates and contains only real completed 2026 records', t => {
  assert.equal(snapshot.metadata.game, 'lol');
  assert.ok(rows.length > 0);
  assert.equal(rows.length, snapshot.rows.length);
  assert.equal(rows.length, snapshot.metadata.actual_completed_maps);
  assert.equal(legacyRows.length, 837, 'The original Tencent/Riot maps remain present.');
  assert.equal(legacyRows.filter(row => row.id.startsWith('lol-tencent-')).length, 803);
  assert.equal(legacyRows.filter(row => row.id.startsWith('lol-riot-')).length, 34);
  const checked = engine.validateRows(rows);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.rows.length, rows.length);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.equal(new Set(rows.map(row => `${row.series_id}:${row.map}`)).size, rows.length);
  for (const row of rows) {
    assert.equal(row.game, 'lol');
    assert.equal(row.synthetic, false);
    assert.equal(row.verified, true);
    assert.equal(String(row.season), '2026');
    assert.equal(beijingYear(row.date), 2026);
    assert.ok(Date.parse(row.available_at) >= Date.parse(row.date));
    assert.ok(Date.parse(row.available_at) <= Date.parse(cutoff));
    assert.ok([row.team_a, row.team_b].includes(row.winner));
    if (row.series_verified === false) assert.equal(row.bo, undefined);
    else assert.ok([1, 3, 5, 7, 9].includes(row.bo));
    assert.equal(new URL(row.source_url).protocol, 'https:');
    if (row.actual_start) assert.ok(Date.parse(row.date) <= Date.parse(row.actual_start));
    if (row.actual_end) assert.ok(Date.parse(row.actual_end) <= Date.parse(row.available_at));
  }
  if (snapshot.metadata.missing?.length) assert.equal(snapshot.metadata.complete, false);
  if (snapshot.metadata.expected_completed_maps > rows.length) assert.equal(snapshot.metadata.complete, false);
  t.diagnostic(`${rows.length} maps, ${new Set(rows.filter(row => row.series_verified !== false).map(row => row.series_id)).size} linked series + ${rows.filter(row => row.series_verified === false).length} unlinked maps; missing items remain visible in source metadata.`);
});

test('five new regions retain real source-year, observed availability and official series evidence', () => {
  assert.ok(regionalRows.length > 0);
  assert.equal(snapshot.metadata.globalRegions.actual_completed_maps, regionalRows.length);
  assert.equal(snapshot.metadata.globalRegions.selectedTeamRows, regionalRows.length * 2);
  assert.ok(snapshot.metadata.globalRegions.rejectedNon2026TeamRows > 0);
  assert.deepEqual([...new Set(regionalRows.map(row => row.league))].sort(), ['CBLOL', 'LCK', 'LCP', 'LCS', 'LEC']);
  for (const row of regionalRows) {
    assert.match(row.source_date_raw, /^2026-/);
    assert.equal(row.source_date_raw.slice(0, 4), String(row.season));
    assert.equal(row.source_date, row.source_date_raw);
    assert.equal(row.availability_basis, 'observed_snapshot');
    assert.equal(row.available_at, row.observed_at);
    assert.equal(row.backtest_eligible, false);
    assert.equal(row.source_timezone, 'unknown');
    assert.equal(row.actual_start, null);
    assert.equal(row.actual_end, null);
    assert.equal(row.draft_verified, true);
    assert.equal(row.license, 'CC BY 4.0');
    assert.ok(row.source_game_id && row.attribution && row.data_url);
    if (row.series_verified) {
      assert.ok(row.riot_series_id && row.riot_game_id && row.series_source_url && row.series_mapping_evidence);
      assert.equal(row.date_basis, 'official_scheduled_series_start');
      assert.equal(Date.parse(row.date), Date.parse(row.scheduled_at));
      assert.equal(row.series_id, `riot:${row.riot_series_id}`);
    } else {
      assert.equal(row.date_basis, 'unknown_timezone_upper_bound');
      assert.equal(Date.parse(row.date), Date.parse(row.source_time_latest));
      assert.ok(Date.parse(row.source_time_earliest) < Date.parse(row.source_time_latest));
      assert.equal(row.series_complete, false);
    }
  }
});

test('historical cutoff is each series first actual start rather than its old scheduled time', () => {
  const series = new Map();
  for (const row of rows) {
    if (!series.has(row.series_id)) series.set(row.series_id, []);
    series.get(row.series_id).push(row);
  }
  for (const group of series.values()) {
    const starts = group.map(row => Date.parse(row.actual_start));
    const ends = group.map(row => Date.parse(row.actual_end));
    if (starts.every(Number.isFinite)) {
      const firstActualStart = Math.min(...starts);
      assert.ok(group.every(row => Date.parse(row.date) === firstActualStart));
    }
    if (ends.every(Number.isFinite)) {
      const lastActualEnd = Math.max(...ends);
      assert.ok(group.every(row => Date.parse(row.available_at) === lastActualEnd));
    }
  }
});

test('actual LoL historical match prediction is finite and unaffected by KPL records', t => {
  const started = performance.now();
  const prediction = engine.predict(rows, historicalRequest);
  assert.equal(prediction.available, true, prediction.error);
  assert.equal(prediction.game, 'lol');
  assert.equal(prediction.model.game, 'lol');
  assert.equal(prediction.model.synthetic, false);
  assert.equal(prediction.model.availabilityCoverage, 1);
  assert.ok(Date.parse(prediction.model.historyAvailableThrough) < Date.parse(latest.date));
  assert.ok(Object.values(prediction.mean).every(Number.isFinite));
  assert.ok(prediction.mean.durationMin > 0 && prediction.mean.durationMin <= 180);
  assert.ok(prediction.mean.killsA >= 0 && prediction.mean.killsB >= 0);
  for (const market of Object.values(prediction.markets)) {
    assert.ok([market.over, market.under, market.push].every(value => value >= 0 && value <= 1));
    assert.ok(Math.abs(market.over + market.under + market.push - 1) < 1e-12);
  }
  assert.deepEqual(engine.predict([...kpl.rows, ...rows], historicalRequest), prediction);
  const prior = rows.filter(row => row.series_id !== latest.series_id && Date.parse(row.date) < Date.parse(latest.date) && Date.parse(row.available_at) < Date.parse(latest.date));
  assert.deepEqual(engine.predict(prior, historicalRequest), prediction);
  t.diagnostic(`Actual ${latest.team_a} vs ${latest.team_b} holdout prediction: ${(performance.now() - started).toFixed(0)} ms; means=${JSON.stringify(prediction.mean)}`);
});

test('LoL records never enter an unchanged KPL forecast', () => {
  const fixture = kpl.fixtures[0];
  assert.ok(fixture);
  const request = { game: 'kpl', teamA: fixture.teamA, teamB: fixture.teamB, date: fixture.date, excludeSeriesId: fixture.id, season: '2026', lookback: 90 };
  const original = engine.predict(kpl.rows, request);
  assert.equal(original.available, true);
  assert.deepEqual(engine.predict([...rows, ...kpl.rows], request), original);
  assert.deepEqual(games.rowsForGame([...rows, ...kpl.rows], 'lol'), rows);
  assert.deepEqual(games.rowsForGame([...rows, ...kpl.rows], 'kpl'), kpl.rows);
});

test('LoL rolling backtest excludes future availability and other games', t => {
  const started = performance.now();
  const request = { game: 'lol', season: '2026', lookback: 90, limit: 40, date: cutoff };
  const result = engine.backtest(rows, request);
  assert.equal(result.available, true, result.error);
  assert.ok(result.count > 0 && result.count <= 40);
  for (const target of result.details) {
    assert.equal(target.game, 'lol');
    assert.ok(Date.parse(target.trainingAvailableThrough) < Date.parse(target.date));
    assert.ok(Date.parse(target.date) < Date.parse(cutoff));
    assert.equal(target.availabilityCoverage, 1);
  }
  assert.ok(Object.values(result.mae).every(value => Number.isFinite(value) && value >= 0));
  assert.ok(Object.values(result.coverage80).every(value => value >= 0 && value <= 1));
  assert.deepEqual(engine.backtest([...kpl.rows, ...rows], request), result);
  assert.deepEqual(engine.backtest(legacyRows, request), result, 'New snapshots cannot alter historical scores before they were observed.');
  const futureAvailability = new Date(Date.parse(cutoff) + 86400000).toISOString();
  const delayed = rows.map(row => row.series_id === latest.series_id ? { ...row, available_at: futureAvailability } : row);
  const delayedResult = engine.backtest(delayed, request);
  assert.ok(delayedResult.details.every(target => target.series_id !== latest.series_id));
  t.diagnostic(`${result.count} real LoL holdouts + isolation rerun: ${(performance.now() - started).toFixed(0)} ms; MAE=${JSON.stringify(result.mae)}`);
});

test('event schedules preserve stable identifiers, actual local dates and pending pairings', () => {
  assert.ok(schedule.tournaments.length > 0);
  const tournamentIds = new Set(schedule.tournaments.map(tournament => tournament.id));
  assert.equal(tournamentIds.size, schedule.tournaments.length);
  assert.equal(new Set(schedule.fixtures.map(fixture => fixture.id)).size, schedule.fixtures.length);
  for (const fixture of schedule.fixtures) {
    assert.equal(fixture.game, 'lol');
    assert.ok(tournamentIds.has(fixture.tournament_id));
    assert.ok(Number.isFinite(Date.parse(fixture.date)));
    assert.equal(beijingYear(fixture.date), 2026);
    assert.ok([1, 3, 5, 7, 9].includes(fixture.bo));
    if (!fixture.teamA || !fixture.teamB) {
      assert.equal(fixture.pending, true);
      const prediction = engine.predict(rows, { game: 'lol', teamA: fixture.teamA, teamB: fixture.teamB, date: fixture.date, season: '2026' });
      assert.equal(prediction.available, false);
    }
  }
  for (const tournament of schedule.tournaments) {
    const fixtures = games.fixturesForTournament(schedule.fixtures, tournament.id);
    assert.ok(fixtures.every(fixture => fixture.tournament_id === tournament.id));
    // An event without a verified detailed schedule remains an empty list. No
    // invented matchup is required to satisfy a tournament's presence in the UI.
    if (tournament.confirmedPairings === 0) assert.ok(fixtures.every(fixture => fixture.pending));
  }
});

test('CSV backup retains LoL identity and BO data needed by each team’s recent 20 series', () => {
  const restored = engine.parseCSV(engine.sampleCSV(rows));
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.rows.length, rows.length);
  assert.ok(restored.rows.every(row => row.game === 'lol' && (row.series_verified === false ? row.bo === undefined : row.bo !== undefined)));
  const restoredById = new Map(restored.rows.map(row => [row.id, row]));
  for (const row of regionalRows) {
    const copy = restoredById.get(row.id);
    for (const key of ['series_verified', 'series_complete', 'backtest_eligible', 'availability_basis', 'observed_at', 'source_date_raw', 'source_date', 'source_timezone', 'source_time_earliest', 'source_time_latest', 'date_basis', 'region', 'league', 'tournament_id', 'source_game_id', 'series_id_basis', 'series_source_url', 'riot_series_id', 'riot_game_id', 'series_mapping_evidence', 'official_tournament_id', 'official_tournament_name', 'scheduled_at', 'source_team_a', 'source_team_b', 'source_team_a_id', 'source_team_b_id', 'license', 'attribution']) assert.equal(copy[key], row[key], `${row.id}.${key}`);
    assert.deepEqual(copy.lineup_a, row.lineup_a);
    assert.deepEqual(copy.lineup_b, row.lineup_b);
  }
  const request = { team: latest.team_a, date: cutoff, limit: 20 };
  const before = recentSeries(rows, request);
  const after = recentSeries(restored.rows, request);
  const select = match => ({ id: match.id, complete: match.complete, outcome: match.outcome, ownWins: match.ownWins, opponentWins: match.opponentWins, ownKills: match.ownKills, opponentKills: match.opponentKills, averageDuration: match.averageDuration });
  assert.ok(before.length > 0 && before.length <= 20);
  assert.ok(before.some(match => match.complete));
  assert.deepEqual(after.map(select), before.map(select));
});

test('new domestic teams become available only after observation, and unlinked maps do not fill recent-series slots', () => {
  const oldTeams = new Set(legacyRows.flatMap(row => [row.team_a, row.team_b]));
  const sample = [...regionalRows].reverse().find(row => row.map === 1 && (!oldTeams.has(row.team_a) || !oldTeams.has(row.team_b)));
  assert.ok(sample);
  const date = new Date(Date.parse(cutoff) + 1000).toISOString();
  const input = { game: 'lol', teamA: sample.team_a, teamB: sample.team_b, date, season: '2026', lookback: 'all', map: 1 };
  assert.equal(engine.predict(legacyRows, input).available, false);
  const forecast = engine.predict(rows, input);
  assert.equal(forecast.available, true, forecast.error);
  assert.ok(Object.values(forecast.mean).every(Number.isFinite));
  assert.ok(forecast.model.observedSnapshotCount > 0);
  assert.deepEqual(engine.predict(rows, { ...input, date: sample.observed_at }), engine.predict(legacyRows, { ...input, date: sample.observed_at }));
  for (const unlinked of regionalRows.filter(row => row.series_verified === false)) {
    const query = { team: unlinked.team_a, date, limit: 20 };
    const matches = recentSeries(rows, query);
    assert.ok(matches.every(match => match.id !== unlinked.series_id));
    assert.deepEqual(matches, recentSeries(rows.filter(row => row.series_verified !== false), query));
    const map = recentUnlinkedMaps(rows, query).find(row => row.id === unlinked.id);
    assert.ok(map);
    assert.equal(map.source_date_raw, unlinked.source_date_raw);
    assert.equal(map.ownKills, unlinked.kills_a);
  }
});

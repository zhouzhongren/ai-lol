import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const engineSource = await readFile(new URL('../dist/engine.js', import.meta.url), 'utf8');
const engineURL = `data:text/javascript;base64,${Buffer.from(engineSource).toString('base64')}`;
const draftSource = (await readFile(new URL('../dist/draft-engine.js', import.meta.url), 'utf8')).replace("'./engine.js'", JSON.stringify(engineURL));
const { predict, parseCSV, sampleCSV } = await import(engineURL);
const { predictDraft, compareDraftBacktest, validateDraft } = await import(`data:text/javascript;base64,${Buffer.from(draftSource).toString('base64')}`);

const teamA = { top: 'Ornn', jungle: 'LeeSin', mid: 'Ahri', bottom: 'Jinx', support: 'Leona' };
const teamB = { top: 'Gnar', jungle: 'Viego', mid: 'Syndra', bottom: 'Varus', support: 'Rell' };
const draft = { teamA, teamB };
// Deliberately synthetic statistical fixtures; no claim about real champion strength.
const rows = Array.from({ length: 150 }, (_, i) => {
  const slow = i % 2 === 0;
  const start = Date.UTC(2026, 0, 1 + i, 12);
  return {
    game: 'lol', id: `SYNTH-DRAFT-${i}-1`, series_id: `SYNTH-DRAFT-${i}`,
    date: new Date(start).toISOString(), available_at: new Date(start + 45 * 60000).toISOString(),
    season: '2026', event: 'Synthetic test only', patch: '', team_a: 'Alpha', team_b: 'Beta',
    map: 1, bo: 1, duration_sec: 1800 + (slow ? 240 : -240) + (i % 3 - 1) * 30,
    kills_a: 16 + (slow ? 5 : -5) + (i % 3 - 1), kills_b: 12 + (slow ? -2 : 2),
    winner: slow ? 'Alpha' : 'Beta', synthetic: true,
    lineup_a: { ...teamA, top: slow ? 'Ornn' : 'Camille' }, lineup_b: { ...teamB }, draft_verified: true,
  };
});
const request = { game: 'lol', teamA: 'Alpha', teamB: 'Beta', date: '2026-06-15T12:00:00Z', season: '2026', lookback: 180, map: 1, durationLine: 30.5, killsLine: 28.5, handicap: 3.5, excludeSeriesId: 'HOLDOUT', draft };

test('opting out preserves the original predictor exactly', () => {
  assert.deepEqual(predictDraft(rows, { ...request, draft: undefined }), predict(rows, request));
});

test('partial, duplicate, invalid-game and unspecified-map drafts cannot silently predict', () => {
  assert.equal(validateDraft(draft).valid, true);
  for (const invalid of [{ teamA }, { teamA: { ...teamA, top: '' }, teamB }, { teamA, teamB: { ...teamB, top: 'ornn' } }]) {
    const result = predictDraft(rows, { ...request, draft: invalid });
    assert.equal(result.available, false);
    assert.equal(result.draft.applied, false);
    assert.equal(result.draft.baseline.available, true);
    assert.equal(result.mean, undefined);
  }
  assert.equal(predictDraft(rows, { ...request, map: 'all' }).available, false);
  assert.equal(predictDraft(rows, { ...request, game: 'kpl' }).available, false);
  assert.equal(predictDraft([], request).available, false);
});

test('hero effects are learned from outcomes rather than a built-in strength table', () => {
  const slow = predictDraft(rows, request);
  const fast = predictDraft(rows, { ...request, draft: { teamA: { ...teamA, top: 'Camille' }, teamB } });
  assert.equal(slow.available, true);
  assert.equal(slow.draft.applied, true);
  assert.equal(slow.draft.trainingCount, rows.length);
  assert.ok(slow.mean.durationMin > fast.mean.durationMin);
  assert.ok(slow.mean.killDiff > fast.mean.killDiff);
  assert.equal(slow.mean.totalKills, Number((slow.mean.killsA + slow.mean.killsB).toFixed(2)));
  assert.equal(slow.mean.killDiff, Number((slow.mean.killsA - slow.mean.killsB).toFixed(2)));
  const reversedOutcomes = rows.map(row => ({ ...row, duration_sec: 3600 - row.duration_sec }));
  const reversedSlow = predictDraft(reversedOutcomes, request);
  const reversedFast = predictDraft(reversedOutcomes, { ...request, draft: { teamA: { ...teamA, top: 'Camille' }, teamB } });
  assert.ok(reversedSlow.mean.durationMin < reversedFast.mean.durationMin);
});

test('draft training shares champion evidence across maps and uses the same pooled baseline', () => {
  const data = rows.map((row, i) => ({ ...row, map: i % 2 === 0 ? 2 : 1, bo: 3 }));
  const result = predictDraft(data, request);
  const baseline = predict(data, request);
  assert.equal(result.draft.applied, true);
  assert.equal(result.draft.trainingCount, data.length);
  assert.equal(result.sample.mapCount, data.filter(row => row.map === request.map).length);
  const ornn = result.draft.championCoverage.find(item => item.side === 'teamA' && item.role === 'top');
  assert.equal(ornn.champion, 'Ornn');
  assert.equal(ornn.count, data.filter(row => row.map === 2).length);
  assert.equal(ornn.effectKnown, true);
  for (const key of ['mean', 'intervals', 'markets', 'sample']) assert.deepEqual(result.draft.baseline[key], baseline[key]);
  const faster = predictDraft(data, { ...request, draft: { teamA: { ...teamA, top: 'Camille' }, teamB } });
  assert.ok(result.mean.durationMin > faster.mean.durationMin);
  assert.ok(result.mean.killDiff > faster.mean.killDiff);
  for (const map of [2, 1, 3]) {
    const input = { ...request, map };
    assert.deepEqual(predictDraft(data, input), predictDraft(structuredClone(data), input));
  }
  const reverse = predictDraft(data, { ...request, teamA: 'Beta', teamB: 'Alpha', handicap: -request.handicap, draft: { teamA: teamB, teamB: teamA } });
  assert.equal(result.mean.durationMin, reverse.mean.durationMin);
  assert.equal(result.mean.totalKills, reverse.mean.totalKills);
  assert.equal(result.mean.killsA, reverse.mean.killsB);
  assert.equal(result.mean.killDiff, -reverse.mean.killDiff);
  assert.ok(Math.abs(result.markets.handicap.over - reverse.markets.handicap.under) < 1e-12);
  const poison = { ...data[0], map: 3, duration_sec: 7000, kills_a: 180 };
  assert.deepEqual(predictDraft([...data,
    { ...poison, id: 'OTHER-MAP-SAME-SERIES', series_id: request.excludeSeriesId },
    { ...poison, id: 'OTHER-MAP-UNAVAILABLE', series_id: 'UNAVAILABLE', available_at: request.date },
    { ...poison, id: 'OTHER-MAP-FUTURE', series_id: 'FUTURE', date: '2026-06-16T12:00:00Z', available_at: '2026-06-16T13:00:00Z' },
  ], request), result);
});

test('a constant lineup adds no duration or total-kill effect to a balanced map-specific baseline', () => {
  const data = Array.from({ length: 80 }, (_, i) => ({
    ...rows[0], id: `BALANCED-DRAFT-${i}`, series_id: `BALANCED-DRAFT-${i}`,
    date: '2026-06-01T12:00:00Z', available_at: '2026-06-01T12:45:00Z',
    map: i % 2 + 1, bo: 3, duration_sec: i % 2 ? 1800 : 1200,
    kills_a: i % 2 ? 20 : 10, kills_b: i % 2 ? 20 : 10,
  }));
  for (const map of [1, 2]) {
    const input = { ...request, map };
    const result = predictDraft(data, input), baseline = predict(data, input);
    assert.equal(result.draft.applied, true);
    assert.equal(result.mean.durationMin, baseline.mean.durationMin);
    // The draft output sums rounded per-team means, unlike the base output.
    assert.ok(Math.abs(result.mean.totalKills - baseline.mean.totalKills) <= 0.011);
    assert.deepEqual(result.intervals, baseline.intervals);
    assert.deepEqual(result.markets, baseline.markets);
  }
});

test('adjusted means, intervals and market probabilities change together without a narrower duration distribution', () => {
  // An empirical CDF can stay flat at 30.5 even when its center moves. This
  // threshold crosses the planted slow-game residual cluster after adjustment.
  const result = predictDraft(rows, { ...request, durationLine: 35.5 });
  const base = result.draft.baseline;
  assert.notEqual(result.mean.durationMin, base.mean.durationMin);
  assert.notEqual(result.markets.duration.over, base.markets.duration.over);
  assert.ok(Math.abs((result.intervals.durationMin[1] - result.intervals.durationMin[0]) - (base.intervals.durationMin[1] - base.intervals.durationMin[0])) <= 0.011);
  for (const market of Object.values(result.markets)) assert.ok(Math.abs(market.over + market.under + market.push - 1) < 1e-12);
  assert.match(result.model.intervalMethod, /未.*缩窄/);
});

test('team and draft reversal preserves totals and flips the kill difference', () => {
  const forward = predictDraft(rows, request);
  const reverse = predictDraft(rows, { ...request, teamA: 'Beta', teamB: 'Alpha', handicap: -request.handicap, draft: { teamA: teamB, teamB: teamA } });
  assert.equal(forward.mean.durationMin, reverse.mean.durationMin);
  assert.equal(forward.mean.totalKills, reverse.mean.totalKills);
  assert.equal(forward.mean.killsA, reverse.mean.killsB);
  assert.equal(forward.mean.killDiff, -reverse.mean.killDiff);
  assert.ok(Math.abs(forward.markets.handicap.over - reverse.markets.handicap.under) < 1e-12);
});

test('future, unavailable and same-series draft information never enters the fit or coverage', () => {
  const base = predictDraft(rows, request);
  const future = { ...rows[0], id: 'future', series_id: 'future', date: '2026-06-16T12:00:00Z', available_at: '2026-06-16T13:00:00Z', kills_a: 180 };
  const unavailable = { ...future, id: 'delayed', series_id: 'delayed', date: '2026-06-14T12:00:00Z' };
  const sameSeries = { ...rows[0], id: 'same-series', series_id: 'HOLDOUT', kills_a: 180 };
  assert.deepEqual(predictDraft([...rows, future, unavailable, sameSeries], request), base);
  const earlier = predictDraft(rows, { ...request, date: '2026-03-01T00:00:00Z' });
  assert.ok(earlier.draft.trainingCount < base.draft.trainingCount);
  assert.ok(earlier.draft.championCoverage.every(item => item.count <= earlier.draft.trainingCount));
  const unknownOnlyInFuture = { ...future, lineup_a: { ...teamA, top: 'NewChampion' } };
  const unknown = predictDraft([...rows, unknownOnlyInFuture], { ...request, draft: { teamA: { ...teamA, top: 'NewChampion' }, teamB } });
  assert.equal(unknown.draft.championCoverage.find(item => item.side === 'teamA' && item.role === 'top').count, 0);
});

test('unverified or malformed historical lineups cannot train hero effects', () => {
  const unverified = rows.map(row => ({ ...row, draft_verified: false }));
  const invalid = rows.map(row => ({ ...row, lineup_b: { ...row.lineup_b, top: row.lineup_a.top } }));
  for (const data of [unverified, invalid, rows.slice(0, 20)]) {
    const result = predictDraft(data, request);
    assert.equal(result.available, true);
    assert.equal(result.draft.applied, false);
    assert.deepEqual(result.mean, result.draft.baseline.mean);
    assert.ok(Object.values(result.draft.delta).every(value => value === 0));
  }
});

test('missing explicit availability leaves an approximate baseline but never a strict draft estimate or paired result', () => {
  const missingTrainingTime = rows.map((row, i) => i === 0 ? { ...row, available_at: undefined } : row);
  const forecast = predictDraft(missingTrainingTime, request);
  assert.equal(forecast.available, true);
  assert.equal(forecast.draft.applied, false);
  assert.equal(forecast.draft.availabilityVerified, false);
  assert.deepEqual(forecast.mean, forecast.draft.baseline.mean);
  assert.match(forecast.draft.warnings.join(''), /available_at/);
  const input = { game: 'lol', season: '2026', lookback: 180, map: 'all', limit: 3, date: request.date };
  const rejectedTraining = compareDraftBacktest(missingTrainingTime, input);
  assert.equal(rejectedTraining.count, 0);
  assert.equal(rejectedTraining.skipReasons.unverifiedAvailability, 3);
  const missingTargetTime = rows.map((row, i) => i === rows.length - 1 ? { ...row, available_at: undefined } : row);
  const rejectedTarget = compareDraftBacktest(missingTargetTime, input);
  assert.equal(rejectedTarget.count, 2);
  assert.equal(rejectedTarget.skipReasons.unverifiedAvailability, 1);
  assert.ok(rejectedTarget.details.every(row => row.availabilityVerified && row.availabilityCoverage === 1));
});

test('regional observed snapshots may train after observation but never enter historical paired targets', () => {
  const observed = rows.map(row => ({ ...row, series_verified: false, backtest_eligible: false,
    availability_basis: 'observed_snapshot', observed_at: '2026-06-14T00:00:00Z', available_at: '2026-06-14T00:00:00Z' }));
  assert.equal(predictDraft(observed, { ...request, date: '2026-06-14T00:00:00Z' }).available, false);
  const forecast = predictDraft(observed, request);
  assert.equal(forecast.available, true);
  assert.equal(forecast.draft.applied, true);
  assert.equal(forecast.draft.trainingCount, rows.length);
  assert.equal(compareDraftBacktest(observed, { game: 'lol', date: request.date, limit: 60 }).attempted, 0);
  const mappedButOnlyObserved = observed.map(row => ({ ...row, series_verified: true, backtest_eligible: true }));
  assert.equal(compareDraftBacktest(mappedButOnlyObserved, { game: 'lol', date: request.date, limit: 60 }).attempted, 0);
});

test('unseen champion-role combinations explicitly contribute zero', () => {
  const unknownA = { ...teamA, top: 'NewChampion' };
  const unknownB = { ...teamA, top: 'DifferentNewChampion' };
  const first = predictDraft(rows, { ...request, draft: { teamA: unknownA, teamB } });
  const second = predictDraft(rows, { ...request, draft: { teamA: unknownB, teamB } });
  assert.deepEqual(first.mean, second.mean);
  assert.equal(first.draft.unseenCount, 1);
  assert.match(first.draft.warnings.join(''), /按 0 回退/);
  const entirelyUnknown = Object.fromEntries(['teamA', 'teamB'].map(side => [side, Object.fromEntries(['top', 'jungle', 'mid', 'bottom', 'support'].map(role => [role, `Unknown${side}${role}`]))]));
  const fallback = predictDraft(rows, { ...request, draft: entirelyUnknown });
  assert.equal(fallback.draft.applied, false);
  assert.equal(fallback.draft.unseenCount, 10);
  assert.deepEqual(fallback.mean, fallback.draft.baseline.mean);
});

test('cache guards dataset changes and does not depend on threshold lines', () => {
  const data = rows.map(row => ({ ...row }));
  const original = predictDraft(data, request);
  const threshold = predictDraft(data, { ...request, durationLine: 20.5 });
  assert.deepEqual(original.mean, threshold.mean);
  assert.notEqual(original.markets.duration.over, threshold.markets.duration.over);
  data[0].duration_sec += 1200;
  data[0].lineup_a = { ...data[0].lineup_a, top: 'Camille' };
  const changed = predictDraft(data, request);
  assert.deepEqual(changed, predictDraft(structuredClone(data), request));
  assert.notDeepEqual(changed.mean, original.mean);
});

test('cache invalidates when an observed timestamp makes a historical snapshot ineligible', () => {
  const data = rows.map(row => ({ ...row, availability_basis: 'observed_snapshot', observed_at: row.available_at }));
  const original = predictDraft(data, request);
  assert.equal(original.draft.trainingCount, data.length);
  // Updating provenance in place must remove this row from both the baseline
  // and the cached draft fit when availability no longer follows observation.
  data[0].observed_at = request.date;
  const changed = predictDraft(data, request);
  assert.equal(changed.sample.league, data.length - 1);
  assert.equal(changed.draft.trainingCount, data.length - 1);
  assert.deepEqual(changed, predictDraft(structuredClone(data), request));
});

test('CSV roundtrip retains verified lineups; malformed JSON fails and partial drafts remain baseline-only', () => {
  const restored = parseCSV(sampleCSV(rows.slice(0, 2)));
  assert.deepEqual(restored.errors, []);
  assert.deepEqual(restored.rows[0].lineup_a, rows[0].lineup_a);
  assert.deepEqual(restored.rows[0].lineup_b, rows[0].lineup_b);
  assert.equal(restored.rows[0].draft_verified, true);
  const malformed = parseCSV(sampleCSV([{ ...rows[0], lineup_a: '{bad json' }]));
  assert.match(malformed.errors.join(''), /不是有效 JSON/);
  const partial = parseCSV(sampleCSV([{ ...rows[0], lineup_a: { top: 'Ornn' } }]));
  assert.deepEqual(partial.errors, []);
  assert.equal(partial.rows[0].draft_verified, false);
  assert.match(partial.warnings.join(''), /不可用于阵容修正/);
});

test('paired chronological backtest uses identical holdouts and reports empirical improvements without presuming them', () => {
  const result = compareDraftBacktest(rows, { game: 'lol', season: '2026', lookback: 180, map: 'all', limit: 12, date: request.date });
  assert.equal(result.available, true);
  assert.equal(result.count, 12);
  assert.equal(result.attempted, result.count + result.skipped);
  assert.equal(result.hyperparametersTunedOnBacktest, false);
  assert.ok(result.draft.mae.durationMin < result.baseline.mae.durationMin); // Only the planted synthetic relationship.
  for (const target of result.details) {
    assert.ok(Date.parse(target.trainingAvailableThrough) < Date.parse(target.date));
    const historical = rows.find(row => row.id === target.id);
    const pruned = rows.filter(row => row.series_id !== target.series_id && Date.parse(row.available_at) < Date.parse(target.date));
    const reproduced = predictDraft(pruned, { ...request, date: target.date, excludeSeriesId: target.series_id, draft: { teamA: historical.lineup_a, teamB: historical.lineup_b } });
    assert.deepEqual(reproduced.mean, target.draft.mean);
    assert.deepEqual(reproduced.draft.baseline.mean, target.baseline.mean);
  }
  const noDraft = compareDraftBacktest(rows.map(row => ({ ...row, draft_verified: false })), { game: 'lol', limit: 70, date: request.date });
  assert.equal(noDraft.attempted, 60);
  assert.equal(noDraft.available, false);
  assert.equal(noDraft.skipReasons.missingOrInvalidDraft, 60);
});

test('real verified drafts survive import and support paired evaluation with no cross-game or future-data contamination', async t => {
  const snapshot = JSON.parse(await readFile(new URL('../dist/lol-data.json', import.meta.url), 'utf8'));
  const actualRows = snapshot.rows;
  assert.ok(actualRows.length > 0);
  const restored = parseCSV(sampleCSV(actualRows));
  assert.deepEqual(restored.errors, []);
  assert.equal(restored.rows.length, actualRows.length);
  const restoredById = new Map(restored.rows.map(row => [row.id, row]));
  for (let i = 0; i < actualRows.length; i++) {
    assert.equal(actualRows[i].synthetic, false);
    assert.equal(actualRows[i].draft_verified, true);
    assert.equal(validateDraft({ teamA: actualRows[i].lineup_a, teamB: actualRows[i].lineup_b }).valid, true);
    const copy = restoredById.get(actualRows[i].id);
    assert.deepEqual(copy.lineup_a, actualRows[i].lineup_a);
    assert.deepEqual(copy.lineup_b, actualRows[i].lineup_b);
    assert.equal(copy.draft_verified, true);
  }
  let firstMap;
  for (const map of ['all', 1]) {
    const result = compareDraftBacktest(actualRows, { game: 'lol', season: '2026', date: snapshot.metadata.cutoff, lookback: 90, map, limit: 60 });
    assert.equal(result.available, true, result.error);
    assert.ok(result.count > 0 && result.attempted <= 60);
    assert.equal(result.attempted, result.count + result.skipped);
    assert.equal(result.synthetic, false);
    assert.equal(result.hyperparametersTunedOnBacktest, false);
    for (const target of result.details) {
      assert.equal(target.availabilityCoverage, 1);
      assert.equal(target.availabilityVerified, true);
      assert.ok(Date.parse(target.trainingThrough) < Date.parse(target.date));
      assert.ok(Date.parse(target.trainingAvailableThrough) < Date.parse(target.date));
      assert.ok(Object.values(target.draft.mean).every(Number.isFinite));
      if (map === 1) assert.equal(target.map, 1);
    }
    for (const variant of [result.baseline, result.draft]) {
      assert.ok(Object.values(variant.mae).every(value => Number.isFinite(value) && value >= 0));
      assert.ok(Object.values(variant.coverage80).every(value => value >= 0 && value <= 1));
    }
    t.diagnostic(`Real map=${map}: ${result.count}/${result.attempted} paired maps, MAE baseline=${JSON.stringify(result.baseline.mae)}, draft=${JSON.stringify(result.draft.mae)}`);
    if (map === 1) firstMap = result;
  }
  const target = firstMap.details.at(-1);
  const historical = actualRows.find(row => row.id === target.id);
  const input = { ...request, teamA: target.teamA, teamB: target.teamB, date: target.date, lookback: 90, excludeSeriesId: target.series_id, draft: { teamA: historical.lineup_a, teamB: historical.lineup_b } };
  const forecast = predictDraft(actualRows, input);
  assert.deepEqual(forecast.mean, target.draft.mean);
  const prior = actualRows.filter(row => row.series_id !== target.series_id && Date.parse(row.date) < Date.parse(target.date) && Date.parse(row.available_at) < Date.parse(target.date));
  assert.deepEqual(predictDraft(prior, input), forecast);
  const kpl = JSON.parse(await readFile(new URL('../dist/data.json', import.meta.url), 'utf8'));
  assert.deepEqual(predictDraft([...kpl.rows, ...actualRows], input), forecast);
  assert.deepEqual(predictDraft(restored.rows, input).mean, forecast.mean);
  const legacy = actualRows.filter(row => !row.id.startsWith('lol-chaincc-'));
  assert.equal(legacy.length, 837);
  const regional = actualRows.filter(row => row.id.startsWith('lol-chaincc-'));
  assert.ok(regional.length > 0);
  const oldTeams = new Set(legacy.flatMap(row => [row.team_a, row.team_b]));
  const regionalMatch = [...regional].reverse().find(row => row.map === 1 && (!oldTeams.has(row.team_a) || !oldTeams.has(row.team_b)));
  assert.ok(regionalMatch);
  const future = { game: 'lol', teamA: regionalMatch.team_a, teamB: regionalMatch.team_b, season: '2026', date: new Date(Date.parse(snapshot.metadata.cutoff) + 1000).toISOString(), lookback: 'all', map: 1, draft: { teamA: regionalMatch.lineup_a, teamB: regionalMatch.lineup_b } };
  const domestic = predictDraft(actualRows, future);
  assert.equal(predictDraft(legacy, future).available, false);
  assert.equal(domestic.available, true, domestic.error);
  assert.equal(domestic.draft.applied, true);
  assert.ok(domestic.draft.trainingCount > 30);
  assert.ok(Object.values(domestic.mean).every(Number.isFinite));
  assert.deepEqual(predictDraft(restored.rows, future).mean, domestic.mean);
  assert.equal(compareDraftBacktest(regional, { game: 'lol', date: future.date, limit: 60 }).attempted, 0);
});

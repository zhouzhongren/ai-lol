#!/usr/bin/env node
/** Paired, chronological evaluation. This script never tunes either model. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_BASELINE = 'aba5aff';
const METRICS = ['durationMin', 'totalKills', 'killDiff'];
const PARAMETERS = Object.freeze({ season: '2026', lookback: 90, minLeagueSamples: 30, minTeamSamples: 6 });
const sha256 = source => createHash('sha256').update(source).digest('hex');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const loadModule = source => import(moduleUrl(source));

async function loadDraft(source, engineSource) {
  let replacements = 0;
  const boundSource = source.replace(/from\s+(['"])\.\/engine\.js\1/g, () => {
    replacements++;
    return `from ${JSON.stringify(moduleUrl(engineSource))}`;
  });
  if (replacements !== 1) throw new Error('Draft engine must import its matching engine exactly once from ./engine.js.');
  const draft = await loadModule(boundSource);
  if (typeof draft.predictDraft !== 'function' || typeof draft.validateDraft !== 'function') {
    throw new Error('Both draft engines must export predictDraft() and validateDraft().');
  }
  return draft;
}

function parseArguments(argv) {
  const options = { from: '2026-08-01T00:00:00Z', to: '2026-10-09T00:00:00Z', includeDetails: false, includeDraft: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--include-details') { options.includeDetails = true; continue; }
    if (flag === '--include-draft') { options.includeDraft = true; continue; }
    if (!['--baseline', '--baseline-draft', '--from', '--to', '--output'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  if (options.includeDraft && options.baseline && !options['baseline-draft']) {
    throw new Error('--include-draft with --baseline requires the matching --baseline-draft FILE.');
  }
  if (options['baseline-draft'] && !options.includeDraft) throw new Error('--baseline-draft requires --include-draft.');
  return options;
}

// Keep scoring policy independent of either model so both see the same candidates.
function targetEligible(row) {
  return !row.synthetic && row.backtest_eligible !== false && row.series_verified !== false &&
    row.availability_basis !== 'observed_snapshot' &&
    !['unknown_timezone_upper_bound', 'official_scheduled_series_start'].includes(row.date_basis);
}

function predictionEligible(prediction) {
  return prediction?.available && prediction.sample.league >= PARAMETERS.minLeagueSamples &&
    Math.min(prediction.sample.teamA, prediction.sample.teamB) >= PARAMETERS.minTeamSamples;
}

function draftPredictionEligible(prediction) {
  return prediction.available && predictionEligible(prediction.draft?.baseline) &&
    prediction.draft.baseline.availabilityCoverage === 1 && prediction.model.availabilityCoverage === 1;
}

function actualOf(row) {
  return { durationMin: row.duration_sec / 60, totalKills: row.kills_a + row.kills_b, killDiff: row.kills_a - row.kills_b };
}

function summarize(details, side) {
  const mae = {}, rmse = {}, coverage80 = {};
  for (const metric of METRICS) {
    let absolute = 0, squared = 0, covered = 0;
    for (const detail of details) {
      const prediction = detail[side], actual = detail.actual[metric];
      const error = prediction.mean[metric] - actual;
      const interval = prediction.intervals[metric];
      if (![actual, error, ...interval].every(Number.isFinite)) throw new Error(`Non-finite ${metric} for ${detail.id} (${side})`);
      absolute += Math.abs(error);
      squared += error * error;
      covered += Number(actual >= interval[0] && actual <= interval[1]);
    }
    mae[metric] = details.length ? absolute / details.length : null;
    rmse[metric] = details.length ? Math.sqrt(squared / details.length) : null;
    coverage80[metric] = details.length ? covered / details.length : null;
  }
  return { mae, rmse, coverage80 };
}

function predictionRecord(prediction) {
  return {
    mean: Object.fromEntries(METRICS.map(metric => [metric, prediction.mean[metric]])),
    intervals: Object.fromEntries(METRICS.map(metric => [metric, prediction.intervals[metric]])),
    sample: prediction.sample,
    trainingThrough: prediction.model.historyTo,
    trainingAvailableThrough: prediction.model.historyAvailableThrough,
    availabilityCoverage: prediction.model.availabilityCoverage,
    modelVersion: prediction.model.version,
    ...(prediction.draft ? { draft: {
      applied: prediction.draft.applied === true,
      trainingCount: prediction.draft.trainingCount,
      unseenCount: prediction.draft.unseenCount,
      availabilityVerified: prediction.draft.availabilityVerified,
    } } : {}),
  };
}

function assertChronology(prediction, row, timestamp) {
  if (!prediction.available) return;
  const cutoff = timestamp(row.date);
  for (const value of [prediction.model.historyTo, prediction.model.historyAvailableThrough]) {
    if (!Number.isFinite(timestamp(value)) || timestamp(value) >= cutoff) {
      throw new Error(`Training chronology failed for ${row.id}`);
    }
  }
  if (prediction.model.excludedSeriesId !== row.series_id) throw new Error(`Series exclusion failed for ${row.id}`);
}

function evaluate(rows, game, mode, baseline, current, from, to, timestamp, draftModules) {
  const isDraft = mode === 'draft';
  const targetDraft = row => ({ teamA: row.lineup_a, teamB: row.lineup_b });
  const candidates = rows.filter(row => targetEligible(row) && timestamp(row.date) >= from &&
    timestamp(row.date) < to && timestamp(row.available_at || row.date) < to &&
    (!isDraft || (row.draft_verified === true && row.available_at && Number.isFinite(timestamp(row.available_at)) &&
      draftModules.baseline.validateDraft(targetDraft(row)).valid && draftModules.current.validateDraft(targetDraft(row)).valid)))
    .sort((a, b) => timestamp(a.date) - timestamp(b.date) || a.series_id.localeCompare(b.series_id) || a.map - b.map);
  const details = [], newlyCovered = [], noLongerCovered = [];
  const baselineSeries = new Set(), currentSeries = new Set();
  let baselineEligibleCount = 0, currentEligibleCount = 0;
  for (const row of candidates) {
    const options = {
      game, season: PARAMETERS.season, lookback: PARAMETERS.lookback,
      map: mode === 'all' ? 'all' : row.map,
      teamA: row.team_a, teamB: row.team_b, date: row.date, excludeSeriesId: row.series_id,
    };
    if (isDraft) options.draft = targetDraft(row);
    const oldPrediction = isDraft ? draftModules.baseline.predictDraft(rows, options) : baseline.predict(rows, options);
    const newPrediction = isDraft ? draftModules.current.predictDraft(rows, options) : current.predict(rows, options);
    assertChronology(oldPrediction, row, timestamp);
    assertChronology(newPrediction, row, timestamp);
    const eligible = isDraft ? draftPredictionEligible : predictionEligible;
    const oldEligible = eligible(oldPrediction), newEligible = eligible(newPrediction);
    if (oldEligible) { baselineEligibleCount++; baselineSeries.add(row.series_id); }
    if (newEligible) { currentEligibleCount++; currentSeries.add(row.series_id); }
    const identity = { id: row.id, series_id: row.series_id, date: row.date, map: row.map };
    if (newEligible && !oldEligible) newlyCovered.push(identity);
    if (oldEligible && !newEligible) noLongerCovered.push(identity);
    if (!oldEligible || !newEligible) continue;
    details.push({
      ...identity, teamA: row.team_a, teamB: row.team_b, actual: actualOf(row),
      baseline: predictionRecord(oldPrediction), current: predictionRecord(newPrediction),
    });
  }
  const baselineMetrics = summarize(details, 'baseline'), currentMetrics = summarize(details, 'current');
  const draftCounts = side => isDraft ? {
    appliedCount: details.filter(detail => detail[side].draft.applied).length,
    fallbackCount: details.filter(detail => !detail[side].draft.applied).length,
  } : {};
  const change = {};
  for (const measure of ['mae', 'rmse', 'coverage80']) {
    change[measure] = Object.fromEntries(METRICS.map(metric => {
      const before = baselineMetrics[measure][metric], after = currentMetrics[measure][metric];
      return [metric, before === null ? null : {
        absolute: after - before,
        ...(measure === 'coverage80' ? { percentagePoints: (after - before) * 100 } :
          { relativePercent: before === 0 ? null : (after / before - 1) * 100 }),
      }];
    }));
  }
  return {
    game, mapMode: mode, candidateCount: candidates.length,
    candidateSeriesCount: new Set(candidates.map(row => row.series_id)).size,
    commonTargetCount: details.length,
    commonSeriesCount: new Set(details.map(row => row.series_id)).size,
    scoredFrom: details[0]?.date ?? null, scoredTo: details.at(-1)?.date ?? null,
    baseline: { eligibleCount: baselineEligibleCount, eligibleSeriesCount: baselineSeries.size, ...baselineMetrics, ...draftCounts('baseline') },
    current: { eligibleCount: currentEligibleCount, eligibleSeriesCount: currentSeries.size, ...currentMetrics, ...draftCounts('current') },
    change,
    newlyCovered: { count: newlyCovered.length, seriesCount: new Set(newlyCovered.map(row => row.series_id)).size, targets: newlyCovered },
    noLongerCovered: { count: noLongerCovered.length, seriesCount: new Set(noLongerCovered.map(row => row.series_id)).size, targets: noLongerCovered },
    details,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/benchmark-model.mjs [--baseline FILE] [--from ISO_DATE] [--to ISO_DATE] [--output FILE] [--include-details] [--include-draft [--baseline-draft FILE]]\nDefaults: baseline=git:aba5aff:dist/engine.js, from=2026-08-01T00:00:00Z, to=2026-10-09T00:00:00Z.\nWithout --output, JSON is written to stdout. The time range is [from, to).\nUse --include-details to include the paired per-target predictions and training audit fields.\nUse --include-draft to also compare complete LoL draft prediction paths; --baseline requires a matching --baseline-draft FILE in this mode.');
    return;
  }
  let baselineSource, baselineOrigin;
  if (options.baseline) {
    const path = resolve(options.baseline);
    baselineSource = await readFile(path, 'utf8');
    baselineOrigin = { path };
  } else {
    try {
      const commit = execFileSync('git', ['rev-parse', `${DEFAULT_BASELINE}^{commit}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      baselineSource = execFileSync('git', ['show', `${commit}:dist/engine.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      baselineOrigin = { gitCommit: commit, path: 'dist/engine.js' };
    } catch {
      throw new Error(`Cannot read baseline ${DEFAULT_BASELINE}:dist/engine.js. Supply a frozen engine file using --baseline FILE.`);
    }
  }
  let baselineDraftSource, baselineDraftOrigin;
  if (options.includeDraft) {
    if (options['baseline-draft']) {
      const path = resolve(options['baseline-draft']);
      baselineDraftSource = await readFile(path, 'utf8');
      baselineDraftOrigin = { path };
    } else {
      try {
        baselineDraftSource = execFileSync('git', ['show', `${baselineOrigin.gitCommit}:dist/draft-engine.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        baselineDraftOrigin = { gitCommit: baselineOrigin.gitCommit, path: 'dist/draft-engine.js' };
      } catch {
        throw new Error('Cannot read the frozen draft engine. Supply a matching --baseline-draft FILE.');
      }
    }
  }
  // Freeze every source at startup, including normalization and current model code.
  const paths = ['dist/engine.js', 'dist/official.js', 'dist/games.js', 'dist/data.json', 'dist/lol-data.json', 'scripts/benchmark-model.mjs'];
  if (options.includeDraft) paths.push('dist/draft-engine.js');
  const contents = await Promise.all(paths.map(path => readFile(resolve(ROOT, path), 'utf8')));
  const [currentSource, officialSource, gamesSource, kplSource, lolSource] = contents;
  const [baseline, current, official, games] = await Promise.all([
    loadModule(baselineSource), loadModule(currentSource), loadModule(officialSource), loadModule(gamesSource),
  ]);
  if (typeof baseline.predict !== 'function' || typeof current.predict !== 'function') throw new Error('Both engines must export predict().');
  let draftModules;
  if (options.includeDraft) {
    const [baselineDraft, currentDraft] = await Promise.all([
      loadDraft(baselineDraftSource, baselineSource), loadDraft(contents[6], currentSource),
    ]);
    draftModules = { baseline: baselineDraft, current: currentDraft };
  }
  const timestamp = baseline.modelInternals?.dateTimestamp;
  if (typeof timestamp !== 'function') throw new Error('Baseline must export modelInternals.dateTimestamp.');
  const from = timestamp(options.from), to = timestamp(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('--from and --to must be valid ISO dates with from earlier than to.');
  const snapshots = {
    kpl: official.normalizeSnapshot(JSON.parse(kplSource)),
    lol: games.normalizeLolSnapshot(JSON.parse(lolSource)),
  };
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dateRange: { fromInclusive: new Date(from).toISOString(), toExclusive: new Date(to).toISOString() },
    parameters: { ...PARAMETERS, mapModes: ['all', 'specific', ...(options.includeDraft ? ['draft'] : [])], kplExcludeChallengerCup: true, includeDetails: options.includeDetails, includeDraft: options.includeDraft },
    code: {
      baseline: { ...baselineOrigin, sha256: sha256(baselineSource) },
      current: { path: 'dist/engine.js', sha256: sha256(currentSource) },
      ...(options.includeDraft ? {
        baselineDraft: { ...baselineDraftOrigin, sha256: sha256(baselineDraftSource) },
        currentDraft: { path: 'dist/draft-engine.js', sha256: sha256(contents[6]) },
      } : {}),
      supportingFiles: Object.fromEntries([1, 2, 5].map(index => [paths[index], { sha256: sha256(contents[index]) }])),
    },
    data: {},
    methodology: [
      'Both models predict each target using only earlier eligible history, with all maps of that target series excluded.',
      'predict() enforces date and available_at strictly before the target. Missing available_at follows the engine fallback to date.',
      'Only real, backtest-eligible targets are scored; snapshot-only and uncertain-time targets are excluded.',
      'All MAE, RMSE and coverage80 comparisons use the intersection of targets with at least 30 league maps and 6 maps per team for both models.',
      'Newly covered and no-longer-covered targets are reported separately and excluded from paired accuracy metrics.',
      'all predicts any map; specific passes each target map number. Both modes use the same date range and eligibility thresholds.',
      ...(options.includeDraft ? [
        'draft is LoL only and compares the complete old and new predictDraft paths using each target map number and its verified full lineups; both paths import their matching engine.',
        'Draft targets require explicit available_at. Each scored forecast requires an eligible baseline and availabilityCoverage=1 throughout its training history.',
        'Draft appliedCount and fallbackCount refer to common targets only. Valid baseline fallbacks remain in the paired comparison; no minimum draft-history gate is imposed by this script.',
      ] : []),
      'Series contain correlated maps; series counts are reported. No statistical significance or guaranteed future improvement is claimed.',
      'Negative MAE/RMSE changes mean lower historical error. Coverage is an observed rate, not an accuracy score; the nominal target is 0.8.',
      'This is a fixed-parameter evaluation, not a tuning run. A period is a holdout only if neither algorithm nor parameters were selected using it.',
    ],
    comparisons: [],
  };
  for (const game of ['kpl', 'lol']) {
    const snapshot = snapshots[game];
    const rows = games.rowsForGame(snapshot.rows, game).filter(row => String(row.season) === PARAMETERS.season &&
      (game !== 'kpl' || (String(row.league_id) !== '20260002' && !String(row.event).includes('挑战者杯'))));
    const validation = current.validateRows(rows);
    if (validation.errors.length) throw new Error(`${game} data validation failed: ${validation.errors.slice(0, 3).join(' ')}`);
    report.data[game] = {
      path: game === 'kpl' ? 'dist/data.json' : 'dist/lol-data.json',
      sha256: sha256(game === 'kpl' ? kplSource : lolSource),
      snapshotRowCount: snapshot.rows.length, modelingRowCount: rows.length,
      sourceCutoff: snapshot.metadata?.cutoff ?? null,
      sourceFetchedAt: snapshot.metadata?.fetchedAt ?? null,
    };
    for (const mode of ['all', 'specific', ...(game === 'lol' && options.includeDraft ? ['draft'] : [])]) {
      const comparison = evaluate(rows, game, mode, baseline, current, from, to, timestamp, draftModules);
      if (!options.includeDetails) delete comparison.details;
      report.comparisons.push(comparison);
    }
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    const destination = resolve(options.output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, json);
    console.error(`Wrote paired model comparison to ${destination}`);
    for (const comparison of report.comparisons) console.error(`${comparison.game} ${comparison.mapMode}: ${comparison.commonTargetCount} common targets, ${comparison.commonSeriesCount} series, ${comparison.newlyCovered.count} newly covered`);
  } else process.stdout.write(json);
}

main().catch(error => {
  console.error(`Model benchmark failed: ${error.message}`);
  process.exitCode = 1;
});

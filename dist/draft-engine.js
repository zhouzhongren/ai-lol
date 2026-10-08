import { predict, modelInternals } from './engine.js';

const { resolveOptions, dateTimestamp, eligibleHistory, fitModel, weightedQuantile, market, validateChampionLineups, backtestTargetEligible, DRAFT_ROLES } = modelInternals;
const METRICS = ['durationMin', 'killsA', 'killsB', 'totalKills', 'killDiff'];
const ROLES = [...DRAFT_ROLES];
const RIDGE = 40;
const MIN_DRAFT_MAPS = 30;
const MAX_PASSES = 40;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const round = (value, digits = 2) => Number(value.toFixed(digits));
const featureKey = (role, champion) => `${role}:${champion.toLowerCase()}`;
const zeroMetrics = () => Object.fromEntries(METRICS.map(key => [key, 0]));
const cache = new WeakMap();

/** Exactly ten unique canonical champion IDs, with five explicit roles per team. */
export function validateDraft(draft) {
  return validateChampionLineups(draft?.teamA, draft?.teamB);
}

function signature(rows) {
  // Array identity prevents cross-dataset reuse. Content guards against an
  // in-place edit to either outcomes, eligibility timestamps or lineups.
  return JSON.stringify(rows.map(row => [row.game, row.id, row.series_id, row.series_verified, row.availability_basis, row.date, row.available_at, row.season, row.map, row.team_a, row.team_b, row.duration_sec, row.kills_a, row.kills_b, row.synthetic, row.draft_verified, ...ROLES.map(role => row.lineup_a?.[role]), ...ROLES.map(role => row.lineup_b?.[role])]));
}

function lineupFeatures(lineups) {
  return ['teamA', 'teamB'].flatMap(side => ROLES.map(role => ({ key: featureKey(role, lineups[side][role]), sign: side === 'teamA' ? 1 : -1 })));
}

function ridgeFit(records, keys, metric, signed) {
  const index = new Map(keys.map((key, i) => [key, i]));
  const columns = keys.map(() => []);
  records.forEach((record, rowIndex) => {
    for (const feature of record.features) columns[index.get(feature.key)].push({ rowIndex, value: signed ? feature.sign : 1 });
  });
  const coefficients = new Float64Array(keys.length);
  const fitted = new Float64Array(records.length);
  let passes = 0;
  for (; passes < MAX_PASSES; passes++) {
    let maxChange = 0;
    for (let column = 0; column < columns.length; column++) {
      let numerator = 0, denominator = RIDGE;
      const previous = coefficients[column];
      for (const { rowIndex, value } of columns[column]) {
        const record = records[rowIndex];
        numerator += record.weight * value * (record.residual[metric] - fitted[rowIndex] + previous * value);
        denominator += record.weight * value * value;
      }
      const next = numerator / denominator;
      const change = next - previous;
      coefficients[column] = next;
      maxChange = Math.max(maxChange, Math.abs(change));
      for (const { rowIndex, value } of columns[column]) fitted[rowIndex] += change * value;
    }
    if (maxChange < 1e-7) { passes++; break; }
  }
  return { values: new Map(keys.map((key, i) => [key, coefficients[i]])), passes };
}

function buildContext(rows, options, cutoff) {
  const history = eligibleHistory(rows, options, cutoff);
  if (!history.length) return null;
  const baselineModel = fitModel(history, cutoff, options.lookback);
  const records = [], counts = new Map();
  for (const { row, weight } of baselineModel.weighted) {
    if (row.draft_verified !== true) continue;
    const validated = validateChampionLineups(row.lineup_a, row.lineup_b);
    if (!validated.valid) continue;
    const baseline = baselineModel.estimate(row.team_a, row.team_b);
    const features = lineupFeatures(validated.lineups);
    for (const feature of features) {
      const value = counts.get(feature.key) || { count: 0, weightedCount: 0 };
      value.count++; value.weightedCount += weight;
      counts.set(feature.key, value);
    }
    records.push({ row, weight, features, residual: {
      durationMin: row.duration_sec / 60 - baseline.durationMin,
      totalKills: row.kills_a + row.kills_b - baseline.totalKills,
      killDiff: row.kills_a - row.kills_b - baseline.killDiff,
    } });
  }
  let effects = null;
  if (records.length >= MIN_DRAFT_MAPS) {
    const keys = [...counts.keys()].sort();
    effects = {
      durationMin: ridgeFit(records, keys, 'durationMin', false),
      totalKills: ridgeFit(records, keys, 'totalKills', false),
      killDiff: ridgeFit(records, keys, 'killDiff', true),
    };
  }
  return { history, baselineModel, records, counts, effects };
}

function getContext(rows, options, cutoff) {
  const dataSignature = signature(rows);
  let stored = cache.get(rows);
  if (!stored || stored.signature !== dataSignature) {
    stored = { signature: dataSignature, contexts: new Map() };
    cache.set(rows, stored);
  }
  // Team choices, draft choices and threshold lines do not affect this fit.
  const key = JSON.stringify([options.game, cutoff, options.season, options.map, Number.isFinite(options.lookback) ? options.lookback : 'all', options.excludeSeriesId || null]);
  if (stored.contexts.has(key)) return stored.contexts.get(key);
  const context = buildContext(rows, options, cutoff);
  if (stored.contexts.size >= 12) stored.contexts.delete(stored.contexts.keys().next().value);
  stored.contexts.set(key, context);
  return context;
}

function baselineReference(baseline) {
  return { available: baseline.available, error: baseline.error, mean: baseline.mean, intervals: baseline.intervals, markets: baseline.markets, sample: baseline.sample, availabilityCoverage: baseline.model?.availabilityCoverage };
}

function draftInfo(baseline, overrides = {}) {
  return {
    applied: false, trainingCount: 0, eligibleCount: baseline.sample?.league || 0,
    coverage: 0, unseenCount: 0, championCoverage: [], baseline: baselineReference(baseline),
    delta: zeroMetrics(), warnings: [], ridge: RIDGE, minimumTrainingMaps: MIN_DRAFT_MAPS,
    method: '对战队基线训练残差拟合英雄×分路岭收缩；时长/总击杀对称，击杀差按 A 正 B 负编码',
    intervalPolicy: '保留基线历史残差波动，仅移动预测中心；未通过阵容训练残差缩窄区间，未保证覆盖率',
    causal: false, sideAdjusted: false, hyperparametersTunedOnBacktest: false,
    availabilityVerified: baseline.model?.availabilityCoverage === 1,
    ...overrides,
  };
}

function shiftedDistribution(context, mean, options) {
  const { baselineModel } = context;
  const a = baselineModel.teams.get(options.teamA), b = baselineModel.teams.get(options.teamB);
  const residualScale = Math.sqrt(1 + 12 / (Math.min(a.weight, b.weight) + 12));
  const outcomes = Object.fromEntries(METRICS.map(key => [key, []]));
  for (const { row, weight } of baselineModel.weighted) {
    const estimated = baselineModel.estimate(row.team_a, row.team_b);
    const actual = { durationMin: row.duration_sec / 60, killsA: row.kills_a, killsB: row.kills_b, totalKills: row.kills_a + row.kills_b, killDiff: row.kills_a - row.kills_b };
    for (const key of METRICS) {
      const residuals = key === 'killDiff' ? [actual[key] - estimated[key], -(actual[key] - estimated[key])] : key === 'killsA' || key === 'killsB' ? [actual.killsA - estimated.killsA, actual.killsB - estimated.killsB] : [actual[key] - estimated[key]];
      for (const residual of residuals) {
        let value = mean[key] + residual * residualScale;
        if (key !== 'killDiff') value = Math.max(key === 'durationMin' ? 1 : 0, value);
        if (key !== 'durationMin') value = Math.round(value);
        outcomes[key].push({ value, weight: weight / residuals.length });
      }
    }
  }
  return {
    intervals: Object.fromEntries(METRICS.map(key => [key, [round(weightedQuantile(outcomes[key], 0.1)), round(weightedQuantile(outcomes[key], 0.9))]])),
    markets: { duration: market(outcomes.durationMin, options.durationLine, false), totalKills: market(outcomes.totalKills, options.killsLine, true), handicap: market(outcomes.killDiff, options.handicap, true) },
  };
}

/** Optional full-draft correction. Omit draft to get the original predictor. */
export function predictDraft(rows, input = {}) {
  const baseline = predict(rows, input);
  if (input.draft === undefined || input.draft === null) return baseline;
  const options = resolveOptions(input);
  const validated = validateDraft(input.draft);
  const errors = [...validated.errors];
  if (options.game !== 'lol') errors.unshift('英雄阵容修正仅支持英雄联盟。');
  if (options.map === 'all') errors.unshift('阵容预测必须指定当前第几局；不同局不能沿用同一套阵容。');
  if (errors.length) {
    return { available: false, game: options.game, error: errors.join('；'), sample: baseline.sample, draft: draftInfo(baseline, { errors, warnings: ['阵容未完整生效；只能查看独立的赛前基线参考。'] }) };
  }
  if (!baseline.available) return { ...baseline, draft: draftInfo(baseline, { warnings: ['战队基线不可用，不能仅凭英雄选择生成预测。'] }) };
  if (baseline.model.availabilityCoverage !== 1) {
    const warnings = ['当前历史窗口有记录缺少明确的数据可用时间 available_at，不能核验严格赛前可用性；阵容修正未启用，仅显示原基线近似参考。'];
    return { ...baseline, draft: draftInfo(baseline, { warnings }), warnings: [...baseline.warnings, ...warnings] };
  }
  const context = getContext(rows, options, dateTimestamp(options.date));
  const championCoverage = ['teamA', 'teamB'].flatMap(side => ROLES.map(role => {
    const champion = validated.lineups[side][role];
    const observed = context.counts.get(featureKey(role, champion));
    return { side, role, champion, count: observed?.count || 0, weightedCount: round(observed?.weightedCount || 0, 2), effectKnown: !!observed };
  }));
  const unseen = championCoverage.filter(champion => !champion.effectKnown);
  const rare = championCoverage.filter(champion => champion.effectKnown && champion.weightedCount < 5);
  const warnings = [];
  if (unseen.length) warnings.push(`${unseen.length} 个英雄/分路组合在当前历史窗口没有可核验样本，其阵容修正按 0 回退。`);
  if (rare.length) warnings.push(`${rare.length} 个英雄/分路组合的加权样本不足 5 局，效应受到强收缩，不能解读为确定强弱。`);
  warnings.push('英雄效应是历史相关性；没有建模英雄配合/克制交互、禁选顺序、红蓝方、选手阵容、赛区整体强弱及版本变化。');
  warnings.push('参数在回测前固定，尚未独立确认阵容模型比基线更准确；概率仍未校准。');
  const info = draftInfo(baseline, {
    trainingCount: context.records.length, eligibleCount: context.history.length,
    coverage: context.records.length / context.history.length,
    unseenCount: unseen.length, championCoverage, warnings,
  });
  if (!context.effects || unseen.length === 10) {
    warnings.unshift(!context.effects ? `完整核验阵容只有 ${context.records.length} 局，低于 ${MIN_DRAFT_MAPS} 局启用门槛；当前显示赛前基线，阵容修正未启用。` : '所选十个英雄/分路组合均无历史样本，当前完全回退赛前基线。');
    return { ...baseline, draft: info, warnings: [...baseline.warnings, ...warnings] };
  }
  const rawDelta = { durationMin: 0, totalKills: 0, killDiff: 0 };
  for (const feature of lineupFeatures(validated.lineups)) {
    rawDelta.durationMin += context.effects.durationMin.values.get(feature.key) || 0;
    rawDelta.totalKills += context.effects.totalKills.values.get(feature.key) || 0;
    rawDelta.killDiff += (context.effects.killDiff.values.get(feature.key) || 0) * feature.sign;
  }
  const original = context.baselineModel.estimate(options.teamA, options.teamB);
  const total = clamp(original.totalKills + rawDelta.totalKills, 0, 400);
  const difference = clamp(original.killDiff + rawDelta.killDiff, -total, total);
  const killsA = clamp((total + difference) / 2, 0, 200), killsB = clamp((total - difference) / 2, 0, 200);
  const rawMean = { durationMin: clamp(original.durationMin + rawDelta.durationMin, 1, 180), killsA, killsB, totalKills: killsA + killsB, killDiff: killsA - killsB };
  const mean = { durationMin: round(rawMean.durationMin), killsA: round(killsA), killsB: round(killsB) };
  mean.totalKills = round(mean.killsA + mean.killsB);
  mean.killDiff = round(mean.killsA - mean.killsB);
  const distribution = shiftedDistribution(context, rawMean, options);
  info.applied = true;
  info.delta = Object.fromEntries(METRICS.map(key => [key, round(mean[key] - baseline.mean[key])]));
  info.fitPasses = Object.fromEntries(Object.entries(context.effects).map(([key, fit]) => [key, fit.passes]));
  return {
    ...baseline, mean, ...distribution, draft: info,
    model: { ...baseline.model, draftAdjusted: true, draftMethod: info.method, draftRidge: RIDGE, draftSideAdjusted: false, intervalMethod: info.intervalPolicy },
    warnings: [...baseline.warnings.filter(message => !message.startsWith('未纳入 BP')), ...warnings],
  };
}

function scores(details, variant) {
  const mae = {}, coverage80 = {};
  for (const key of METRICS) {
    mae[key] = round(details.reduce((sum, target) => sum + Math.abs(target[variant].mean[key] - target.actual[key]), 0) / details.length);
    coverage80[key] = details.filter(target => target.actual[key] >= target[variant].intervals[key][0] && target.actual[key] <= target[variant].intervals[key][1]).length / details.length;
  }
  return { mae, coverage80 };
}

/** Paired chronological evaluation; never selects tuning parameters by score. */
export function compareDraftBacktest(rows, input = {}) {
  const options = resolveOptions(input);
  const limit = clamp(Math.floor(Number(input.limit) || 40), 1, 60);
  const cutoff = input.date ? dateTimestamp(input.date) : Infinity;
  const skipReasons = { missingOrInvalidDraft: 0, unverifiedAvailability: 0, insufficientBaseline: 0, insufficientDraftHistory: 0, predictionUnavailable: 0 };
  if (options.game !== 'lol' || Number.isNaN(cutoff)) return { available: false, game: options.game, count: 0, attempted: 0, skipped: 0, skipReasons, error: '阵容对照回测需要英雄联盟数据和有效截止时间。', details: [] };
  const candidates = rows.filter(row => backtestTargetEligible(row) && resolveOptions({ game: row.game }).game === 'lol' &&
    dateTimestamp(row.date) < cutoff && dateTimestamp(row.available_at || row.date) < cutoff &&
    (options.season === 'all' || String(row.season) === options.season) &&
    (options.map === 'all' || row.map === options.map) &&
    (!options.excludeSeriesId || row.series_id !== options.excludeSeriesId)
  ).sort((a, b) => dateTimestamp(a.date) - dateTimestamp(b.date) || a.map - b.map).slice(-limit);
  const details = [];
  for (const row of candidates) {
    if (!row.available_at || !Number.isFinite(dateTimestamp(row.available_at))) { skipReasons.unverifiedAvailability++; continue; }
    const validated = validateChampionLineups(row.lineup_a, row.lineup_b);
    if (row.draft_verified !== true || !validated.valid) { skipReasons.missingOrInvalidDraft++; continue; }
    const forecast = predictDraft(rows, { ...options, teamA: row.team_a, teamB: row.team_b, date: row.date, map: row.map, excludeSeriesId: row.series_id, draft: validated.lineups });
    const base = forecast.draft?.baseline;
    if (!base?.available || base.sample.league < 30 || Math.min(base.sample.teamA, base.sample.teamB) < 6) { skipReasons.insufficientBaseline++; continue; }
    if (!forecast.draft.availabilityVerified) { skipReasons.unverifiedAvailability++; continue; }
    if (forecast.draft.trainingCount < MIN_DRAFT_MAPS) { skipReasons.insufficientDraftHistory++; continue; }
    if (!forecast.available) { skipReasons.predictionUnavailable++; continue; }
    const actual = { durationMin: row.duration_sec / 60, killsA: row.kills_a, killsB: row.kills_b, totalKills: row.kills_a + row.kills_b, killDiff: row.kills_a - row.kills_b };
    details.push({
      id: row.id, series_id: row.series_id, game: 'lol', date: row.date, map: row.map, teamA: row.team_a, teamB: row.team_b, actual,
      baseline: { mean: base.mean, intervals: base.intervals }, draft: { mean: forecast.mean, intervals: forecast.intervals },
      draftApplied: forecast.draft.applied, unseenCount: forecast.draft.unseenCount,
      trainingCount: forecast.draft.trainingCount, baselineTrainingCount: base.sample.league,
      trainingThrough: forecast.model.historyTo, trainingAvailableThrough: forecast.model.historyAvailableThrough,
      availabilityCoverage: base.availabilityCoverage, availabilityVerified: forecast.draft.availabilityVerified,
    });
  }
  const shared = {
    game: 'lol', count: details.length, attempted: candidates.length, skipped: candidates.length - details.length, skipReasons,
    appliedCount: details.filter(target => target.draftApplied).length, fallbackCount: details.filter(target => !target.draftApplied).length,
    details, ridge: RIDGE, minimumTrainingMaps: MIN_DRAFT_MAPS, hyperparametersTunedOnBacktest: false,
    methodology: '同一真实历史局配对比较。每局都按其真实局序，仅用开赛前数据已可用且不属同系列赛的数据；目标局及其整个训练窗口必须有明确的 available_at，否则跳过。英雄模型只用完整已核验阵容。岭惩罚40、30局门槛在回测前固定，未根据本回测挑选参数；测试结果不保证未来提升。差值=阵容−基线，MAE负值才代表本样本误差减少。',
  };
  if (!details.length) return { ...shared, available: false, error: '没有同时满足战队样本与完整阵容历史要求的可比较对局。' };
  const baseline = scores(details, 'baseline'), draft = scores(details, 'draft');
  return { ...shared, available: true, baseline, draft, difference: {
    mae: Object.fromEntries(METRICS.map(key => [key, round(draft.mae[key] - baseline.mae[key])])),
    coverage80: Object.fromEntries(METRICS.map(key => [key, draft.coverage80[key] - baseline.coverage80[key]])),
  }, from: details[0].date, to: details.at(-1).date, synthetic: candidates.some(row => row.synthetic) };
}

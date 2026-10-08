/** Group full series before selecting each team's latest matches. */
function timestamp(value) {
  const text = String(value ?? '').trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00+08:00`);
  return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text) ? `${text}+08:00` : text);
}

export function recentSeries(rows, { team, date, excludeSeriesId, limit = 20 }) {
  const cutoff = timestamp(date);
  if (!Number.isFinite(cutoff) || !team) return [];
  const groups = new Map();
  for (const row of rows) {
    if (!row.series_id || row.series_id === excludeSeriesId) continue;
    if (!groups.has(row.series_id)) groups.set(row.series_id, []);
    groups.get(row.series_id).push(row);
  }
  const matches = [];
  for (const [id, group] of groups) {
    if (group.some(row => row.series_verified === false)) continue;
    if (!group.every(row => (row.team_a === team || row.team_b === team) && timestamp(row.date) < cutoff && timestamp(row.available_at || row.date) < cutoff)) continue;
    const opponents = new Set(group.map(row => row.team_a === team ? row.team_b : row.team_a));
    if (opponents.size !== 1) continue;
    const opponent = [...opponents][0];
    const maps = [...group].sort((a, b) => a.map - b.map).map(row => ({
      ...row,
      ownKills: row.team_a === team ? row.kills_a : row.kills_b,
      opponentKills: row.team_a === team ? row.kills_b : row.kills_a,
      outcome: row.winner === team ? 'win' : row.winner === opponent ? 'loss' : 'unknown',
    }));
    const ownWins = maps.filter(row => row.outcome === 'win').length;
    const opponentWins = maps.filter(row => row.outcome === 'loss').length;
    const allWinnersKnown = ownWins + opponentWins === maps.length;
    const formats = new Set(maps.map(row => Number(row.bo)));
    const bo = formats.size === 1 ? Number(maps[0].bo) : NaN;
    const winsNeeded = Math.floor(bo / 2) + 1;
    const contiguous = maps.every((row, index) => row.map === index + 1);
    const complete = maps.every(row => row.series_complete !== false) && allWinnersKnown && contiguous && [1, 3, 5, 7, 9].includes(bo) && Math.max(ownWins, opponentWins) === winsNeeded && Math.min(ownWins, opponentWins) < winsNeeded;
    const first = maps.reduce((a, b) => timestamp(a.date) <= timestamp(b.date) ? a : b);
    matches.push({
      id, date: first.date, date_basis: first.date_basis, source_date_raw: first.source_date_raw, scheduled_at: first.scheduled_at,
      team, opponent, event: first.event || '', maps,
      ownWins, opponentWins, allWinnersKnown, complete,
      outcome: complete ? (ownWins > opponentWins ? 'win' : 'loss') : 'unknown',
      ownKills: maps.reduce((sum, row) => sum + row.ownKills, 0),
      opponentKills: maps.reduce((sum, row) => sum + row.opponentKills, 0),
      averageDuration: maps.reduce((sum, row) => sum + row.duration_sec, 0) / maps.length,
      source_url: maps.find(row => row.source_url)?.source_url || '',
    });
  }
  return matches.sort((a, b) => timestamp(b.date) - timestamp(a.date) || b.id.localeCompare(a.id)).slice(0, limit);
}

/** Unlinked maps are separate records and never occupy the 20-series quota. */
export function recentUnlinkedMaps(rows, { team, date, excludeSeriesId, limit = 20 }) {
  const cutoff = timestamp(date);
  if (!Number.isFinite(cutoff) || !team) return [];
  return rows.filter(row => row.series_verified === false && row.series_id !== excludeSeriesId &&
    (row.team_a === team || row.team_b === team) && timestamp(row.date) < cutoff &&
    row.available_at && timestamp(row.available_at) < cutoff &&
    (row.availability_basis !== 'observed_snapshot' || timestamp(row.available_at) >= timestamp(row.observed_at))
  ).sort((a, b) => timestamp(b.date) - timestamp(a.date) || String(b.id).localeCompare(String(a.id)))
    .slice(0, Math.max(0, Math.floor(limit)))
    .map(row => ({ ...row, recordType: 'map', seriesVerified: false,
      ownKills: row.team_a === team ? row.kills_a : row.kills_b,
      opponentKills: row.team_a === team ? row.kills_b : row.kills_a,
      opponent: row.team_a === team ? row.team_b : row.team_a,
      outcome: row.winner === team ? 'win' : row.winner === (row.team_a === team ? row.team_b : row.team_a) ? 'loss' : 'unknown',
    }));
}

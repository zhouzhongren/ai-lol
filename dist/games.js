/** Pure game-routing helpers. Data fetching and model fitting live elsewhere. */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const gameCode = value => {
  const code = String(value ?? '').trim().toLowerCase();
  if (!code || code === 'kpl' || code === '王者荣耀') return 'kpl';
  if (code === 'lol' || code === '英雄联盟' || code === 'league of legends') return 'lol';
  return null;
};
const hasGame = row => row.game !== undefined && row.game !== null && String(row.game).trim() !== '';

/** Untagged legacy records belong to KPL; an unknown explicit tag never does. */
export function gameOf(row) {
  return isRecord(row) ? gameCode(row.game) : null;
}

/** Filter before computing team lists, recent series, league scopes or forecasts. */
export function rowsForGame(rows, game = 'kpl') {
  const target = gameCode(game);
  if (!target || !Array.isArray(rows)) return [];
  return rows.filter(row => gameOf(row) === target);
}

const teamName = value => typeof value === 'string' ? value.trim() : '';
const pendingTeam = value => !value || /^(?:tbd(?:\s*\d+)?|tba|待定|待确认|待确定|未确定|unknown|暂无|—|-|\?)$/i.test(value);
const trueFlag = value => value === true || value === 1 || (typeof value === 'string' && /^(true|1)$/i.test(value.trim()));
const tournamentKey = fixture => {
  const explicit = fixture.tournament_id ?? fixture.tournamentId;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') return String(explicit).trim();
  if (isRecord(fixture.tournament)) return String(fixture.tournament.id ?? fixture.tournament.tournament_id ?? '').trim();
  if (typeof fixture.tournament === 'string' || typeof fixture.tournament === 'number') return String(fixture.tournament).trim();
  return '';
};

/**
 * Call ONLY for a file/provider already identified as League of Legends.
 * Within that explicit context, legacy untagged rows can safely receive `lol`.
 * Explicit KPL/unknown records are excluded, and an explicitly conflicting
 * snapshot game is rejected instead of relabeling the entire dataset.
 * This helper does not certify statistics; validateRows handles their schema.
 */
export function normalizeLolSnapshot(raw = {}) {
  const source = isRecord(raw) ? raw : {};
  const metadata = isRecord(source.metadata) ? source.metadata : {};
  const declared = source.game ?? metadata.game;
  if (declared !== undefined && declared !== null && String(declared).trim() !== '' && gameCode(declared) !== 'lol') {
    throw new TypeError('英雄联盟数据入口不能读取声明为其他游戏的快照。');
  }
  const accept = row => isRecord(row) && (!hasGame(row) || gameOf(row) === 'lol');
  const rows = (Array.isArray(source.rows) ? source.rows : []).filter(accept).map(row => ({ ...row, game: 'lol' }));
  const fixtures = (Array.isArray(source.fixtures) ? source.fixtures : []).filter(accept).map(fixture => {
    const teamA = teamName(fixture.teamA ?? fixture.team_a);
    const teamB = teamName(fixture.teamB ?? fixture.team_b);
    const normalized = {
      ...fixture,
      game: 'lol',
      teamA,
      teamB,
      // Preserve an upstream pending signal even when two provisional names exist.
      // The independent `confirmed` field is retained without rewriting its value.
      pending: trueFlag(fixture.pending) || pendingTeam(teamA) || pendingTeam(teamB),
    };
    const key = tournamentKey(fixture);
    if (key) normalized.tournament_id = key;
    return normalized;
  });
  return {
    ...source,
    game: 'lol',
    rows,
    fixtures,
    metadata: { ...metadata },
    tournaments: Array.isArray(source.tournaments) ? source.tournaments.map(tournament => isRecord(tournament) ? { ...tournament } : tournament) : [],
  };
}

/** Select by an explicit stable tournament ID, never an array position. */
export function fixturesForTournament(fixtures, tournament = 'all') {
  if (!Array.isArray(fixtures)) return [];
  const valid = fixtures.filter(isRecord);
  if (tournament === 'all') return valid;
  if (tournament === undefined || tournament === null || String(tournament).trim() === '') return [];
  const target = String(tournament).trim();
  return valid.filter(fixture => tournamentKey(fixture) === target);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/games.js', import.meta.url), 'utf8');
const { gameOf, rowsForGame, normalizeLolSnapshot, fixturesForTournament } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('legacy game routing defaults only untagged records to KPL', () => {
  assert.equal(gameOf({}), 'kpl');
  assert.equal(gameOf({ game: '' }), 'kpl');
  assert.equal(gameOf({ game: 'KPL' }), 'kpl');
  assert.equal(gameOf({ game: '王者荣耀' }), 'kpl');
  assert.equal(gameOf({ game: ' LOL ' }), 'lol');
  assert.equal(gameOf({ game: '英雄联盟' }), 'lol');
  assert.equal(gameOf({ game: 'League of Legends' }), 'lol');
  assert.equal(gameOf({ game: 'other' }), null);
  assert.equal(gameOf(null), null);
  assert.equal(gameOf('lol'), null);
});

test('rowsForGame rejects cross-game and unknown tags without changing input', () => {
  const rows = Object.freeze([Object.freeze({ id: 'legacy' }), Object.freeze({ id: 'kpl', game: 'kpl' }), Object.freeze({ id: 'lol', game: 'lol' }), Object.freeze({ id: 'unknown', game: 'unknown' }), null]);
  assert.deepEqual(rowsForGame(rows).map(row => row.id), ['legacy', 'kpl']);
  assert.deepEqual(rowsForGame(rows, 'lol').map(row => row.id), ['lol']);
  assert.deepEqual(rowsForGame(rows, 'unknown'), []);
  assert.deepEqual(rowsForGame(null, 'lol'), []);
  assert.equal(rows.length, 5);
});

test('explicit LoL file context tags untagged rows and preserves metadata and tournaments', () => {
  const raw = {
    metadata: { source: 'fixture-only test provider', year: 2026, notes: ['test data'] },
    tournaments: [{ id: 'cup-2026', name: 'Sample Cup' }],
    rows: [{ id: 'legacy-lol' }, { id: 'lol', game: 'lol' }, { id: 'kpl', game: 'kpl' }, { id: 'unknown', game: 'unknown' }],
    fixtures: [{ id: 'fixture1', tournamentId: 'cup-2026', team_a: 'Team A', team_b: 'Team B' }],
  };
  const before = structuredClone(raw);
  const normalized = normalizeLolSnapshot(raw);
  assert.equal(normalized.game, 'lol');
  assert.deepEqual(normalized.rows.map(row => [row.id, row.game]), [['legacy-lol', 'lol'], ['lol', 'lol']]);
  assert.equal(normalized.fixtures[0].tournament_id, 'cup-2026');
  assert.deepEqual(normalized.metadata, raw.metadata);
  assert.deepEqual(normalized.tournaments, raw.tournaments);
  assert.notEqual(normalized.metadata, raw.metadata);
  assert.notEqual(normalized.tournaments[0], raw.tournaments[0]);
  assert.deepEqual(raw, before);
  assert.deepEqual(normalizeLolSnapshot(normalized), normalized);
});

test('missing or placeholder opponents are pending and do not get invented names', () => {
  const fixtures = [
    { id: 'missing-a', teamB: 'Team B' },
    { id: 'missing-b', teamA: 'Team A' },
    { id: 'empty', teamA: ' ', teamB: '' },
    { id: 'tbd', teamA: 'Team A', teamB: 'TBD' },
    { id: 'pending-name', teamA: 'Team A', teamB: '待定' },
    { id: 'malformed-name', teamA: { name: 'unverified nested field' }, teamB: 'Team B' },
  ];
  const normalized = normalizeLolSnapshot({ fixtures });
  assert.ok(normalized.fixtures.every(fixture => fixture.pending === true && fixture.game === 'lol'));
  assert.equal(normalized.fixtures[0].teamA, '');
  assert.equal(normalized.fixtures[5].teamA, '');
});

test('upstream pending is preserved and confirmed metadata is never forced false', () => {
  const { fixtures } = normalizeLolSnapshot({ fixtures: [
    { id: 'confirmed', teamA: 'A', teamB: 'B', confirmed: true, pending: false },
    { id: 'provisional', teamA: 'A', teamB: 'B', pending: true },
    { id: 'partial-confirmed', teamA: 'A', confirmed: true },
    { id: 'string-false', teamA: 'A', teamB: 'B', pending: 'false' },
  ] });
  assert.equal(fixtures[0].confirmed, true);
  assert.equal(fixtures[0].pending, false);
  assert.equal(fixtures[1].pending, true);
  assert.equal(fixtures[2].confirmed, true);
  assert.equal(fixtures[2].pending, true);
  assert.equal(fixtures[3].pending, false);
});

test('explicit other-game snapshots fail closed instead of relabeling records', () => {
  assert.throws(() => normalizeLolSnapshot({ game: 'kpl', rows: [{ id: 'kpl-map' }] }), /其他游戏/);
  assert.throws(() => normalizeLolSnapshot({ metadata: { game: 'kpl' }, rows: [{ id: 'kpl-map' }] }), /其他游戏/);
  const normalized = normalizeLolSnapshot({ game: 'lol', fixtures: [{ game: 'kpl', teamA: 'A', teamB: 'B' }, { game: 'unrecognized' }] });
  assert.deepEqual(normalized.fixtures, []);
});

test('tournament filters use stable IDs and preserve pending fixtures', () => {
  const fixtures = [
    { id: 'f1', tournament_id: 'worlds-2026', pending: true },
    { id: 'f2', tournamentId: 'cup-2026' },
    { id: 'f3', tournament: { id: 'worlds-2026' } },
    { id: 'f4', tournament: 'cup-2026' },
    { id: 'f5', tournament_id: '42' },
  ];
  assert.deepEqual(fixturesForTournament(fixtures, 'worlds-2026').map(row => row.id), ['f1', 'f3']);
  assert.deepEqual(fixturesForTournament(fixtures, 'cup-2026').map(row => row.id), ['f2', 'f4']);
  assert.deepEqual(fixturesForTournament(fixtures, 42).map(row => row.id), ['f5']);
  assert.deepEqual(fixturesForTournament(fixtures, 0), []);
  assert.deepEqual(fixturesForTournament(fixtures, 'unknown'), []);
  assert.equal(fixturesForTournament(fixtures).length, 5);
  assert.equal(fixturesForTournament(fixtures, 'worlds-2026')[0].pending, true);
});

test('empty malformed collections normalize safely without mutating an input', () => {
  assert.deepEqual(normalizeLolSnapshot(null), { game: 'lol', rows: [], fixtures: [], metadata: {}, tournaments: [] });
  assert.deepEqual(normalizeLolSnapshot({ rows: 'invalid', fixtures: {}, tournaments: null }).rows, []);
  assert.deepEqual(fixturesForTournament(null), []);
  assert.deepEqual(fixturesForTournament([null, 'invalid'], 'all'), []);
});

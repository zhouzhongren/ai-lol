import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../dist/champion-picker.js', import.meta.url), 'utf8');
const { championRoles, championChoices, nextDraftSlot } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const champion = (id, roles = {}, picks = 0, name = id, title = id) => ({ id, name, title, historical_picks: picks, observed_roles: roles });

test('usual roles preserve flex picks while excluding rare off-role appearances', () => {
  assert.deepEqual(championRoles(champion('Flex', { top: 100, jungle: 20, mid: 19, bottom: 1 })), ['top', 'jungle']);
  assert.deepEqual(championRoles(champion('Small', { mid: 10, support: 2 })), ['mid']);
  assert.deepEqual(championRoles(champion('New', { mid: 1, top: 1 })), ['top', 'mid']);
});

test('zero samples and champion class tags cannot invent player positions', () => {
  for (const value of [undefined, { tags: ['Support', 'Mage'] }, champion('Zero', { support: 0 }), champion('Invalid', { top: -2, mid: NaN })]) {
    assert.deepEqual(championRoles(value), []);
  }
});

test('position filtering ranks by that position before overall popularity', () => {
  const catalog = [champion('Popular', { mid: 10, top: 30 }, 100), champion('Regular', { mid: 20 }, 30), champion('Top', { top: 100, mid: 1 }, 101), champion('Unseen')];
  const snapshot = structuredClone(catalog);
  assert.deepEqual(championChoices(catalog, { role: 'mid' }).map(c => c.id), ['Regular', 'Popular']);
  assert.deepEqual(championChoices({ champions: catalog }, { role: 'mid', showAll: true }).map(c => c.id), ['Regular', 'Popular', 'Top', 'Unseen']);
  assert.deepEqual(catalog, snapshot);
});

test('search finds off-role and unseen champions by id, Chinese name or title', () => {
  const catalog = [champion('Garen', { top: 30 }, 30, '德玛西亚之力', '盖伦'), champion('NewHero', {}, 0, '新英雄', '新人')];
  for (const query of [' GAREN ', '德玛西亚', '盖伦']) assert.deepEqual(championChoices(catalog, { role: 'support', query }).map(c => c.id), ['Garen']);
  assert.deepEqual(championChoices(catalog, { role: 'support', query: '新人' }).map(c => c.id), ['NewHero']);
  assert.deepEqual(championChoices(catalog, { role: 'support', query: '   ' }), []);
  assert.deepEqual(championChoices(catalog, { role: 'support', query: '不存在' }), []);
});

test('ties use overall picks, then Chinese name and id deterministically', () => {
  const catalog = [champion('B', { mid: 10 }, 10, '阿狸'), champion('Z', { mid: 10 }, 10, '佐伊'), champion('A', { mid: 10 }, 10, '阿狸'), champion('P', { mid: 10 }, 20, '佐伊')];
  const expected = ['P', 'A', 'B', 'Z'];
  assert.deepEqual(championChoices(catalog, { role: 'mid' }).map(c => c.id), expected);
  assert.deepEqual(championChoices([...catalog].reverse(), { role: 'mid' }).map(c => c.id), expected);
});

test('next slot follows team and position order, skips filled slots, and wraps', () => {
  const draft = { teamA: { top: 'A', jungle: 'B', mid: 'C' }, teamB: {} };
  const snapshot = structuredClone(draft);
  assert.equal(nextDraftSlot(draft, 'teamA.top'), 'teamA.bottom');
  assert.equal(nextDraftSlot(draft, 'teamA.support'), 'teamB.top');
  assert.equal(nextDraftSlot(draft, 'teamB.support'), 'teamA.bottom');
  assert.equal(nextDraftSlot({}, undefined), 'teamA.top');
  assert.deepEqual(draft, snapshot);
});

test('a complete draft has no next slot; the current slot can be the only empty slot', () => {
  const roles = ['top', 'jungle', 'mid', 'bottom', 'support'];
  const draft = Object.fromEntries(['teamA', 'teamB'].map(side => [side, Object.fromEntries(roles.map(role => [role, `${side}.${role}`]))]));
  assert.equal(nextDraftSlot(draft, 'teamA.mid'), null);
  draft.teamA.mid = '';
  assert.equal(nextDraftSlot(draft, 'teamA.mid'), 'teamA.mid');
});

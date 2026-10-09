const ROLES = ['top', 'jungle', 'mid', 'bottom', 'support'];
const SLOTS = ['teamA', 'teamB'].flatMap(side => ROLES.map(role => `${side}.${role}`));
const names = new Intl.Collator('zh-CN', { sensitivity: 'base', numeric: true });
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const roleCount = (champion, role) => count(champion?.observed_roles?.[role]);

// A rare off-role appearance should not flood that position's usual picks.
// Preserve every most-used role even when only one or two games are available.
export function championRoles(champion) {
  const maximum = Math.max(...ROLES.map(role => roleCount(champion, role)));
  if (!maximum) return [];
  const threshold = Math.max(3, maximum * 0.2);
  return ROLES.filter(role => {
    const picks = roleCount(champion, role);
    return picks === maximum || picks >= threshold;
  });
}

export function championChoices(catalog, { role, query = '', showAll = false } = {}) {
  const champions = Array.isArray(catalog) ? catalog : catalog?.champions || [];
  const search = String(query).trim().toLowerCase();
  return champions.filter(champion => {
    if (search) return [champion.id, champion.name, champion.title]
      .some(value => String(value || '').toLowerCase().includes(search));
    return showAll || !ROLES.includes(role) || championRoles(champion).includes(role);
  }).sort((a, b) => roleCount(b, role) - roleCount(a, role)
    || count(b.historical_picks) - count(a.historical_picks)
    || names.compare(String(a.name || ''), String(b.name || ''))
    || names.compare(String(a.id || ''), String(b.id || ''))
    || (String(a.id || '') < String(b.id || '') ? -1 : String(a.id || '') > String(b.id || '') ? 1 : 0));
}

export function nextDraftSlot(draft, currentSlot) {
  const start = SLOTS.indexOf(currentSlot);
  for (let offset = 1; offset <= SLOTS.length; offset++) {
    const slot = SLOTS[(start + offset) % SLOTS.length];
    const [side, role] = slot.split('.');
    if (!String(draft?.[side]?.[role] || '').trim()) return slot;
  }
  return null;
}

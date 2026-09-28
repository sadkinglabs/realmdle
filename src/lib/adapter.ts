// Turns the Sorcery Card Registry export (KairosArchive's `registry.json`)
// into Realmdle's `Card` shape. This is the only file that knows that
// format; see https://github.com/sadkinglabs/sorcery-registry for the schema.

import { ELEMENTS, RARITIES, type Card, type CardData, type Element, type Rarity } from './types';

/** The parts of a registry v3 export Realmdle reads. */
export type RegistryExport = {
  sets: { set_code: string; set_name: string; released_at: string; kind: string }[];
  cards: {
    codex_id: string;
    name: string;
    type: string;
    category: string;
    rarity: string | null;
    subtypes: string[];
    /** ["None"] for colourless cards. */
    elements: string[];
    cost: number | null;
    power: number | null;
    set_codes: string[];
    image_urls: { normal: string } | null;
  }[];
  printings: {
    printing_id: string;
    codex_id: string;
    set_code: string;
    product: string;
    finish: string;
    image_urls: { normal: string } | null;
    /** "A Unique Site at creation’s core": rarity, type and a flavour phrase. */
    typeline?: string | null;
  }[];
};

/**
 * Sets whose cards another set reprinted unchanged: Beta is Alpha again, so
 * two entries would look the same except for the set, which players found
 * confusing. A card in both keeps only the later entry; the few only ever
 * printed in Alpha keep theirs.
 */
const SUPERSEDED_BY: Record<string, string> = { Alpha: 'Beta' };

const isElement = (e: string): e is Element => (ELEMENTS as readonly string[]).includes(e);
const isRarity = (r: string | null): r is Rarity => r !== null && (RARITIES as readonly string[]).includes(r);

/** The printing that stands for a card in a set: a standard booster copy if there is one. */
function representative(printings: RegistryExport['printings']): RegistryExport['printings'][number] {
  const rank = (p: RegistryExport['printings'][number]) => (p.product === 'Booster' ? 0 : 2) + (p.finish === 'Standard' ? 0 : 1);
  return [...printings].sort((a, b) => rank(a) - rank(b) || a.printing_id.localeCompare(b.printing_id))[0];
}

/**
 * One entry per card per release set: a card reprinted in a later set (say
 * Gothic) is a separate possible answer there, with that set's stats. Alpha
 * is the exception: its cards are only kept where Beta did not reprint them
 * (SUPERSEDED_BY). Foils and other finishes within a set are the same
 * entry. Promo printings are left out: the promo set is dated before
 * Alpha, which would make "older" and "newer" clues meaningless.
 */
export function normalise(registry: RegistryExport, source: string, fetchedAt: string, sha256: string | null): CardData {
  const releases = registry.sets.filter((s) => s.kind === 'release').sort((a, b) => a.released_at.localeCompare(b.released_at));
  const setName = new Map(releases.map((s) => [s.set_code, s.set_name]));
  const order = releases.map((s) => s.set_code);

  const bySet = new Map<string, RegistryExport['printings']>();
  for (const p of registry.printings) {
    if (!setName.has(p.set_code)) continue;
    const key = `${p.codex_id}-${p.set_code}`;
    bySet.set(key, [...(bySet.get(key) ?? []), p]);
  }

  const cards: Card[] = [];
  for (const c of registry.cards) {
    if (c.category === 'Token') continue;
    for (const code of order) {
      const printings = bySet.get(`${c.codex_id}-${code}`);
      if (!printings) continue;
      // Beta reprinted Alpha card for card, so a card in both is only its Beta entry
      const successor = SUPERSEDED_BY[setName.get(code)!];
      const later = successor && releases.find((s) => s.set_name === successor);
      if (later && bySet.has(`${c.codex_id}-${later.set_code}`)) continue;
      const shown = representative(printings);
      cards.push({
        id: `${c.codex_id}-${code}`,
        name: c.name,
        type: c.type,
        elements: ELEMENTS.filter((e) => c.elements.filter(isElement).includes(e)),
        // The registry has no X: a variable value is stored as null, like a
        // site's missing cost. Tell them apart so X never matches None.
        cost: c.cost ?? (c.type === 'Site' || c.type === 'Avatar' ? null : 'X'),
        power: c.power ?? (c.type === 'Minion' ? 'X' : null),
        rarity: isRarity(c.rarity) ? c.rarity : null,
        subtypes: c.subtypes ?? [],
        set: setName.get(code)!,
        image: shown.image_urls?.normal ?? null,
        typeline: shown.typeline || null,
      });
    }
  }
  // by name, then by set in release order (ids end in the set code)
  cards.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { fetchedAt, source, sha256, sets: releases.map((s) => s.set_name), setDates: releases.map((s) => s.released_at), cards };
}

import { describe, expect, it } from 'vitest';
import { normalise, type RegistryExport } from './adapter';

// Made-up records in the registry v3 export shape.
type RawCard = RegistryExport['cards'][number];
type RawPrinting = RegistryExport['printings'][number];

const record = (over: Partial<RawCard>): RawCard => ({
  codex_id: 'C000001',
  name: 'Test Imp',
  type: 'Minion',
  category: 'Spell',
  rarity: 'Ordinary',
  subtypes: ['Demon'],
  elements: ['Fire'],
  cost: 2,
  power: 1,
  set_codes: ['001'],
  image_urls: null,
  ...over,
});

let next = 0;
const printing = (codex_id: string, set_code: string, over: Partial<RawPrinting> = {}): RawPrinting => {
  next += 1;
  const printing_id = `P${String(next).padStart(6, '0')}`;
  return { printing_id, codex_id, set_code, product: 'Booster', finish: 'Standard', image_urls: { normal: `https://img.test/${printing_id}.webp` }, ...over };
};

const registry: RegistryExport = {
  sets: [
    { set_code: '002', set_name: 'Second', released_at: '2024-01-01', kind: 'release' },
    { set_code: '001', set_name: 'First', released_at: '2023-01-01', kind: 'release' },
    { set_code: '999', set_name: 'Promo', released_at: '2022-01-01', kind: 'promo' },
  ],
  cards: [
    record({}),
    record({ codex_id: 'C000002', name: 'Test Tower', type: 'Site', category: 'Site', subtypes: [], elements: ['None'], cost: null, power: null }),
    record({ codex_id: 'C000003', name: 'Test Token', category: 'Token' }),
    record({ codex_id: 'C000004', name: 'Promo Only' }),
    record({ codex_id: 'C000005', name: 'Test Avatar', type: 'Avatar', category: 'Avatar', rarity: null, elements: ['Water', 'Air'] }),
  ],
  printings: [
    // Test Imp: a foil listed first, then the standard copy, in both sets, plus a promo
    printing('C000001', '001', { finish: 'Foil' }),
    printing('C000001', '001'),
    printing('C000001', '002'),
    printing('C000001', '999'),
    printing('C000002', '002'),
    printing('C000003', '001'),
    printing('C000004', '999'),
    printing('C000005', '001', { image_urls: null }),
  ],
};

describe('normalise', () => {
  const data = normalise(registry, 'src', 'now', 'abc');
  const ids = data.cards.map((c) => c.id);

  it('orders release sets by date and leaves promos out', () => {
    expect(data.sets).toEqual(['First', 'Second']);
  });

  it('makes one entry per card per release set', () => {
    expect(ids).toEqual(['C000005-001', 'C000001-001', 'C000001-002', 'C000002-002']);
  });

  it('keeps the same stats across sets, with the set and art of that printing', () => {
    const [first, second] = data.cards.filter((c) => c.name === 'Test Imp');
    expect(first).toEqual({ id: 'C000001-001', name: 'Test Imp', type: 'Minion', elements: ['Fire'], cost: 2, power: 1, rarity: 'Ordinary', subtypes: ['Demon'], set: 'First', image: 'https://img.test/P000002.webp' });
    expect(second).toEqual({ ...first, id: 'C000001-002', set: 'Second', image: 'https://img.test/P000003.webp' });
  });

  it('leaves out tokens and promo printings, and reads colourless and avatars', () => {
    expect(ids.some((id) => id.startsWith('C000003') || id.startsWith('C000004') || id.endsWith('999'))).toBe(false);
    expect(data.cards.find((c) => c.name === 'Test Tower')).toMatchObject({ elements: [], subtypes: [] });
    expect(data.cards.find((c) => c.name === 'Test Avatar')).toMatchObject({ elements: ['Air', 'Water'], rarity: null, image: null });
  });
});

// The card shape Realmdle plays with. Whatever the upstream API returns is
// normalised into this by `adapter.ts`, so the game never touches raw data.

export const ELEMENTS = ['Air', 'Earth', 'Fire', 'Water'] as const;
export type Element = (typeof ELEMENTS)[number];

export const RARITIES = ['Ordinary', 'Exceptional', 'Elite', 'Unique'] as const;
export type Rarity = (typeof RARITIES)[number];

export type Card = {
  /**
   * The card in one set: the registry's codex_id and the set code, e.g.
   * C000001-002 is Apprentice Wizard in Beta. Both parts are permanent.
   */
  id: string;
  name: string;
  /** Minion, Magic, Aura, Artifact, Site or Avatar. */
  type: string;
  /** Empty for colourless cards. Sorted in ELEMENTS order. */
  elements: Element[];
  /** Mana cost; null for cards without one (sites, avatars). */
  cost: number | null;
  /** Attack power; null for anything that is not a unit. */
  power: number | null;
  rarity: Rarity | null;
  /** Mortal, Beast, Monster, Spirit and so on; empty for most spells and sites. Revealed as the last-guess hint. */
  subtypes: string[];
  /** The set this entry is from. Its position in `CardData.sets` gives release order. */
  set: string;
  /** Art to reveal once the puzzle is over, if the source provides one. */
  image: string | null;
};

export type CardData = {
  /** ISO time of the last successful fetch, null if never fetched. */
  fetchedAt: string | null;
  source: string;
  /** Checksum of the registry export this was made from, to skip re-downloading it. */
  sha256: string | null;
  /** Release set names, oldest first. */
  sets: string[];
  /** Release date (YYYY-MM-DD) of each set in `sets`, same order. */
  setDates: string[];
  cards: Card[];
};

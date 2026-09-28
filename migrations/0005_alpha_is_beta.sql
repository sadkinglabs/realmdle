-- The card pool no longer has Alpha entries for cards Beta reprinted
-- (SUPERSEDED_BY in src/lib/adapter.ts): players found two identical cards
-- that differ only by set confusing. Every Alpha id (set code 001) for such
-- a card becomes its Beta id (002), in planned answers and in the guesses
-- already made. The six cards only ever printed in Alpha keep their ids:
-- the four elemental Avatars, Erik's Curiosa and Winter River.

UPDATE puzzles
SET card_id = substr(card_id, 1, 8) || '002'
WHERE card_id LIKE '%-001'
  AND substr(card_id, 1, 7) NOT IN ('C000393', 'C000394', 'C000395', 'C000396', 'C000289', 'C000405');

-- guesses is a JSON array of ids, e.g. ["C000307-001","C000029-002"]:
-- move every Alpha id across, then put back the Alpha-only ones.
UPDATE plays
SET guesses =
  replace(replace(replace(replace(replace(replace(replace(guesses,
    '-001"', '-002"'),
    'C000393-002"', 'C000393-001"'),
    'C000394-002"', 'C000394-001"'),
    'C000395-002"', 'C000395-001"'),
    'C000396-002"', 'C000396-001"'),
    'C000289-002"', 'C000289-001"'),
    'C000405-002"', 'C000405-001"')
WHERE guesses LIKE '%-001"%';

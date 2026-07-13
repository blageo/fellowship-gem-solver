// Fellowship gear/itemization constants — edit this file when the game updates
// costs, pool sizes, or adds new categories. Same pattern as game-constants.js.
import { COLORS } from "./game-constants.js";

export const SEASON = "EAS3";
export const PATCH = "0.4.2";

export const ITEM_SLOTS = [
  "helm", "shoulders", "chest", "legs", "gloves", "boots",
  "neck", "bracers", "ring_1", "ring_2", "relic_1", "relic_2", "weapon",
];

export const ITEM_TYPES = ["normal", "set", "weapon", "relic"];

// Upgrade order low -> high. Legendary always drops as legendary; it is a
// terminal state, never reached via an Epic Souldust upgrade.
export const RARITIES = ["green", "blue", "purple", "yellow", "red", "legendary"];
export const RARITY_RANK = Object.fromEntries(RARITIES.map((r, i) => [r, i]));

export const LEAGUES = ["contender", "adept", "champion", "paragon", "eternal"];

export const RANDOM_STAT_TYPES = [
  "mainStat", "stamina", "haste", "expertise", "criticalStrike", "spirit",
];

// Modifier slot categories and how many outcomes exist in each pool. Souldust
// reroll expected cost for a category is always 5 * poolSize Marks, regardless
// of whether you use the 5 Mark (1 outcome) or 10 Mark (2 outcomes) souldust —
// see EXPECTED_REROLL_MARKS below.
export const MODIFIER_CATEGORIES = {
  majorTrait: { poolSize: 9 },
  heroicTrait: { poolSize: 9 },
  defensiveTrait: { poolSize: 9 },
  blessing: { poolSize: 14 },
  gemEssence: { poolSize: 6 },
  bonusStat: { poolSize: 6 },
  // Fixed, one outcome per set/weapon/relic — locked, never rerolled.
  setBonus: { poolSize: 1, locked: true },
  weaponAbility: { poolSize: 1, locked: true },
  relicAbility: { poolSize: 1, locked: true },
};

// Categories a Legendary Souldust reroll can land you on (excludes the fixed,
// locked slot-1 categories, which can never be targeted by any reroll).
export const REROLLABLE_CATEGORIES = Object.keys(MODIFIER_CATEGORIES)
  .filter((c) => !MODIFIER_CATEGORIES[c].locked);

// Named pools for the categories with a known, fixed roster of outcomes.
// setBonus/weaponAbility/relicAbility have no pool here — each set/weapon/
// relic has its own single fixed ability, an open-ended list we don't track.
export const MODIFIER_NAMES = {
  majorTrait: [
    "Amethyst Splinters", "Brave Machinations", "Diamond Strike", "Emerald Judgement",
    "Heroic Brand", "Martial Initiative", "Ruby Storm", "Sapphire Aurastone", "Visions of Grandeur",
  ],
  heroicTrait: [
    "Hidden Power", "Hunter's Focus", "Inspired Allegiance", "Kindling",
    "Navigator's Intuition", "Patient Soul", "Seized Opportunity", "Vengeful Soul", "Willful Momentum",
  ],
  defensiveTrait: [
    "Divine Mediation", "First Man Standing", "Grounded Spirit", "Heart of Stone", "Iron Spikes",
    "King of the Hill", "Latent Resurgence", "Stalwart Readiness", "Treasure Hunter's Delight",
  ],
  blessing: [
    "The Celestial", "The Herald", "The Heretic", "The Intrepid", "The Monarch", "The Mystic",
    "The Philosopher", "The Sinister", "The Subduer", "The Trickster", "The Usurper",
    "The Vainglorious", "The Vehement", "The Wayfarer",
  ],
  gemEssence: COLORS,           // +100 Gem Power in one gem colour per slot
  bonusStat: RANDOM_STAT_TYPES, // "same types as random stats"
};

for (const [cat, names] of Object.entries(MODIFIER_NAMES)) {
  if (names.length !== MODIFIER_CATEGORIES[cat].poolSize) {
    throw new Error(`MODIFIER_NAMES.${cat} has ${names.length} names, expected poolSize ${MODIFIER_CATEGORIES[cat].poolSize}`);
  }
}

// How many modifier slots + random stats are unlocked at each rarity, and
// whether the newly-added slot/stat "floods" (duplicates the prior one)
// rather than rolling fresh. Index aligns with RARITIES.
export const RARITY_UNLOCKS = {
  green: { modifierSlots: 0, randomStats: 1 },
  blue: { modifierSlots: 1, randomStats: 1 },
  purple: { modifierSlots: 2, randomStats: 1, floods: "modifierSlot" },
  yellow: { modifierSlots: 2, randomStats: 2, floods: "randomStat" },
  red: { modifierSlots: 3, randomStats: 2, floods: "modifierSlot" },
  legendary: { modifierSlots: 3, randomStats: 2 },
};

// --- Souldust costs (Marks, unless noted) ---------------------------------
export const SOULDUST_COST = {
  uncommon: 5,   // reroll ALL slots of a chosen category -> random, same category
  rare: 10,      // same, but pick from 2 generated outcomes
  epic: 15,      // upgrade rarity by 1 tier
  legendary: null, // dungeon drop only; not purchasable with Marks
};

export const RARITY_UPGRADE_COST = SOULDUST_COST.epic; // 15 Marks per tier

// Expected Marks to land a *specific* modifier within a category, using
// 5 Mark rerolls (10 Mark has identical expected cost, only useful when 2+
// specific outcomes are acceptable). = 5 * poolSize.
export const EXPECTED_REROLL_MARKS = Object.fromEntries(
  Object.entries(MODIFIER_CATEGORIES).map(([cat, { poolSize }]) => [cat, SOULDUST_COST.uncommon * poolSize])
);

// Vendor random Small gems: all price points are 5 Marks/gem.
export const VENDOR_SMALL_GEM_COST_PER_GEM = 5;

// --- Weapon trait tree lattice --------------------------------------------
// 5 tiers, alternating option counts. Connectivity from a 2-option tier to a
// 3-option tier: left -> {left, middle}; right -> {middle, right}.
// From a 3-option tier to a 2-option tier: left -> left; middle -> either;
// right -> right. A valid path yields 2 Heroic + 2 Defensive + 1 Major trait.
export const TRAIT_TREE_SHAPE = [
  { type: "heroic", optionCount: 2 },
  { type: "defensive", optionCount: 3 },
  { type: "heroic", optionCount: 2 },
  { type: "defensive", optionCount: 3 },
  { type: "major", optionCount: 2 },
];

// tierIndex -> from-option -> array of reachable to-options in tierIndex+1
export const TRAIT_TREE_EDGES = [
  // tier 0 (2 opts) -> tier 1 (3 opts)
  { 0: [0, 1], 1: [1, 2] },
  // tier 1 (3 opts) -> tier 2 (2 opts)
  { 0: [0], 1: [0, 1], 2: [1] },
  // tier 2 (2 opts) -> tier 3 (3 opts)
  { 0: [0, 1], 1: [1, 2] },
  // tier 3 (3 opts) -> tier 4 (2 opts)
  { 0: [0], 1: [0, 1], 2: [1] },
];

// --- Neck attunements ------------------------------------------------------
export const NECK_ATTUNEMENT_POOL_SIZE = 11;
export const NECK_ATTUNEMENT_ROWS = 2;
export const NECK_ATTUNEMENT_OPTIONS_PER_ROW = 2;
// Reroll cost is unresearched — left null on purpose (see EXPANSION notes).
export const NECK_ATTUNEMENT_REROLL_COST = null;

// Named pool, recorded now for a future neck attunement picker UI (not built
// yet — see gear.html's "not yet supported" note on the neck slot).
export const NECK_ATTUNEMENT_NAMES = [
  "The Bat", "The Boar", "The Dragon", "The Gryphon", "The Lake", "The Mountain",
  "The Oak", "The River", "The Stag", "The Viper", "The Wolf",
];

if (NECK_ATTUNEMENT_NAMES.length !== NECK_ATTUNEMENT_POOL_SIZE) {
  throw new Error(`NECK_ATTUNEMENT_NAMES has ${NECK_ATTUNEMENT_NAMES.length} names, expected ${NECK_ATTUNEMENT_POOL_SIZE}`);
}

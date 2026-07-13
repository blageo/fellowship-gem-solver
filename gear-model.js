// Fellowship gear data model — plain factory functions + validation. No UI,
// no `document` references (must stay environment-agnostic, same rule as
// solver.js). Pure data shapes agreed in the gear-system design handoff.

import {
  ITEM_SLOTS, ITEM_TYPES, RARITIES, RARITY_RANK, LEAGUES,
  RANDOM_STAT_TYPES, MODIFIER_CATEGORIES, RARITY_UNLOCKS,
  TRAIT_TREE_SHAPE, TRAIT_TREE_EDGES,
  NECK_ATTUNEMENT_ROWS, NECK_ATTUNEMENT_OPTIONS_PER_ROW,
} from "./gear-constants.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- GearItem --------------------------------------------------------------

export function makeGearItem({
  id, name, slot, itemType, setName, rarity, league,
  baseStats = [], randomStats = [], modifierSlots = [],
  traitTree = null, neckAttunements = null,
} = {}) {
  assert(ITEM_SLOTS.includes(slot), `unknown slot: ${slot}`);
  assert(ITEM_TYPES.includes(itemType), `unknown itemType: ${itemType}`);
  assert(itemType !== "set" || typeof setName === "string", "set items require setName");
  assert(RARITIES.includes(rarity), `unknown rarity: ${rarity}`);
  assert(LEAGUES.includes(league), `unknown league: ${league}`);
  assert(randomStats.length <= 2, "randomStats: max 2");
  for (const r of randomStats) {
    assert(RANDOM_STAT_TYPES.includes(r.stat), `unknown random stat: ${r.stat}`);
  }
  assert(modifierSlots.length <= 3, "modifierSlots: max 3");
  for (const m of modifierSlots) {
    assert(Object.keys(MODIFIER_CATEGORIES).includes(m.category), `unknown modifier category: ${m.category}`);
  }

  const unlock = RARITY_UNLOCKS[rarity];
  assert(modifierSlots.length <= unlock.modifierSlots,
    `${rarity} only unlocks ${unlock.modifierSlots} modifier slot(s), got ${modifierSlots.length}`);
  assert(randomStats.length <= unlock.randomStats,
    `${rarity} only unlocks ${unlock.randomStats} random stat(s), got ${randomStats.length}`);

  if (slot === "weapon" && traitTree) {
    assert(RARITY_RANK[rarity] >= RARITY_RANK.purple, "trait tree requires purple+ rarity");
    validateTraitTree(traitTree);
  }
  if (slot === "neck" && neckAttunements) {
    assert(RARITY_RANK[rarity] >= RARITY_RANK.purple, "neck attunements require purple+ rarity");
    validateNeckAttunements(neckAttunements);
  }

  return {
    id, name, slot, itemType, setName, rarity, league,
    baseStats: [...baseStats],
    randomStats: randomStats.map((r) => ({ ...r })),
    modifierSlots: modifierSlots.map((m) => ({ ...m })),
    traitTree: slot === "weapon" ? traitTree : undefined,
    neckAttunements: slot === "neck" ? neckAttunements : undefined,
  };
}

// --- WeaponTraitTree ---------------------------------------------------

export function makeWeaponTraitTree({ unlocked = false, tiers, chosen = [null, null, null, null, null] } = {}) {
  assert(Array.isArray(tiers) && tiers.length === 5, "traitTree: exactly 5 tiers");
  tiers.forEach((tier, i) => {
    assert(tier.type === TRAIT_TREE_SHAPE[i].type, `tier ${i} must be type ${TRAIT_TREE_SHAPE[i].type}`);
    assert(tier.options.length === TRAIT_TREE_SHAPE[i].optionCount,
      `tier ${i} must have ${TRAIT_TREE_SHAPE[i].optionCount} options`);
  });
  const tree = { unlocked, tiers: tiers.map((t) => ({ ...t, options: [...t.options] })), chosen: [...chosen] };
  validateTraitTree(tree);
  return tree;
}

function validateTraitTree(tree) {
  assert(tree.tiers.length === 5, "traitTree: exactly 5 tiers");
  assert(tree.chosen.length === 5, "traitTree.chosen: exactly 5 entries");
  tree.chosen.forEach((choice, i) => {
    if (choice === null) return;
    const optionCount = TRAIT_TREE_SHAPE[i].optionCount;
    assert(choice >= 0 && choice < optionCount, `chosen[${i}] out of range for tier with ${optionCount} options`);
  });
  // adjacent chosen tiers must be lattice-connected
  for (let i = 0; i < 4; i++) {
    const from = tree.chosen[i];
    const to = tree.chosen[i + 1];
    if (from === null || to === null) continue;
    const reachable = TRAIT_TREE_EDGES[i][from] || [];
    assert(reachable.includes(to), `tier ${i}->${i + 1} choice ${from}->${to} is not connected`);
  }
}

// Is `path` (array of 5 option indices, entries may be null for "don't care")
// reachable through the trait tree lattice? Used to check whether a desired
// TargetGearItem.traitPath is achievable at all (traits are rolled on drop,
// not rerollable, so this is a feasibility check, not a cost).
export function isTraitPathReachable(path) {
  assert(path.length === 5, "path: exactly 5 entries");
  try {
    validateTraitTree({ tiers: TRAIT_TREE_SHAPE.map((s) => ({ type: s.type, options: Array(s.optionCount).fill("") })), chosen: path });
    return true;
  } catch {
    return false;
  }
}

// --- NeckAttunements -----------------------------------------------------

export function makeNeckAttunements({ unlockedRows = 0, rows, chosen = [null, null] } = {}) {
  assert(Array.isArray(rows) && rows.length === NECK_ATTUNEMENT_ROWS, `neck attunements: exactly ${NECK_ATTUNEMENT_ROWS} rows`);
  rows.forEach((row, i) => {
    assert(row.length === NECK_ATTUNEMENT_OPTIONS_PER_ROW, `row ${i}: exactly ${NECK_ATTUNEMENT_OPTIONS_PER_ROW} options`);
  });
  const attunements = { unlockedRows, rows: rows.map((r) => [...r]), chosen: [...chosen] };
  validateNeckAttunements(attunements);
  return attunements;
}

function validateNeckAttunements(a) {
  assert(a.unlockedRows >= 0 && a.unlockedRows <= NECK_ATTUNEMENT_ROWS, "unlockedRows out of range");
  a.chosen.forEach((choice, i) => {
    if (choice === null) return;
    assert(a.rows[i] && a.rows[i].includes(choice), `chosen[${i}] (${choice}) not among row ${i} options`);
  });
}

// --- TargetGearItem -------------------------------------------------------

export function makeTargetGearItem({
  minRarity, randomStats = [], modifierSlots = [], traitPath, neckWanted = [],
} = {}) {
  if (minRarity !== undefined) assert(RARITIES.includes(minRarity), `unknown rarity: ${minRarity}`);
  assert(randomStats.length <= 2, "randomStats: max 2 (only roll 1 and roll 2 ever exist)");
  for (const s of randomStats) assert(RANDOM_STAT_TYPES.includes(s), `unknown random stat: ${s}`);
  assert(modifierSlots.length <= 3, "modifierSlots: max 3");
  // A null/undefined entry means "no requirement for this slot position" —
  // it's kept (not stripped) so a requirement on e.g. only slot 3 stays at
  // index 2 instead of silently shifting to index 0.
  for (const m of modifierSlots) {
    if (!m) continue;
    assert(Object.keys(MODIFIER_CATEGORIES).includes(m.category), `unknown modifier category: ${m.category}`);
  }
  if (traitPath !== undefined) {
    assert(traitPath.length === 5, "traitPath: exactly 5 entries");
  }
  return {
    minRarity,
    randomStats: [...randomStats],
    modifierSlots: modifierSlots.map((m) => (m ? { ...m } : null)),
    traitPath: traitPath ? [...traitPath] : undefined,
    neckWanted: [...neckWanted],
  };
}

// --- GearBuild -------------------------------------------------------------

export function makeGearBuild({ id, name, gemBuildId, slots = {} } = {}) {
  for (const slotKey of Object.keys(slots)) {
    assert(ITEM_SLOTS.includes(slotKey), `unknown slot: ${slotKey}`);
  }
  const cloned = {};
  for (const slotKey of ITEM_SLOTS) {
    const entry = slots[slotKey];
    cloned[slotKey] = entry ? { current: entry.current, target: entry.target } : { current: undefined, target: undefined };
  }
  return { id, name, gemBuildId, slots: cloned };
}

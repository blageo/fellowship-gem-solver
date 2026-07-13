// Gear upgrade cost calculator — pure math, no UI, environment-agnostic.
// Given a current GearItem and a TargetGearItem, compute the expected Marks
// (and scarce Legendary Souldust) cost to reach it.
//
// Two mechanics drive every expected-value figure here:
//  1. A 5 Mark reroll randomizes within a category (poolSize outcomes).
//     Landing on one *specific* outcome takes, in expectation, `poolSize`
//     attempts -> 5 * poolSize Marks (10 Mark reroll has identical expected
//     cost; it only helps if 2+ outcomes are acceptable, which this
//     calculator doesn't currently model).
//  2. A Legendary Souldust reroll swaps a slot to a random *different*
//     category, uniformly among the other reachable categories. That makes
//     each attempt memoryless: given N reachable categories, the chance of
//     landing the desired one next try is 1/(N-1), so expected attempts to
//     land a specific different category = N - 1.
//
// Legendary Souldust is dungeon-drop-only and scarce, so callers should treat
// `legendarySouldust` as the figure to minimise first, ahead of totalMarks.

import {
  RARITY_RANK, RARITIES, MODIFIER_CATEGORIES, RARITY_UNLOCKS,
  REROLLABLE_CATEGORIES, RARITY_UPGRADE_COST, EXPECTED_REROLL_MARKS,
  NECK_ATTUNEMENT_POOL_SIZE, NECK_ATTUNEMENT_ROWS, NECK_ATTUNEMENT_OPTIONS_PER_ROW,
} from "./gear-constants.js";
import { isTraitPathReachable } from "./gear-model.js";

const MAX_UPGRADABLE_RARITY = "red"; // Legendary is drop-only, never souldust-upgraded into.
const EXPECTED_LEGENDARY_REROLLS_TO_CATEGORY = REROLLABLE_CATEGORIES.length - 1;

function rankForSlotCount(count) {
  for (const rarity of RARITIES) {
    if (RARITY_UNLOCKS[rarity].modifierSlots >= count) return RARITY_RANK[rarity];
  }
  return RARITY_RANK[RARITIES[RARITIES.length - 1]];
}

function rankForStatCount(count) {
  for (const rarity of RARITIES) {
    if (RARITY_UNLOCKS[rarity].randomStats >= count) return RARITY_RANK[rarity];
  }
  return RARITY_RANK[RARITIES[RARITIES.length - 1]];
}

export function computeUpgradeCost(current, target) {
  const notes = [];
  const currentRank = RARITY_RANK[current.rarity];
  const maxRank = RARITY_RANK[MAX_UPGRADABLE_RARITY];

  // --- required final rarity (driven by minRarity + slot/stat requirements) ---
  let requiredRank = currentRank;
  if (target.minRarity) {
    requiredRank = Math.max(requiredRank, RARITY_RANK[target.minRarity]);
  }
  if (target.modifierSlots?.length) {
    requiredRank = Math.max(requiredRank, rankForSlotCount(target.modifierSlots.length));
  }
  if (target.randomStats?.length) {
    requiredRank = Math.max(requiredRank, rankForStatCount(target.randomStats.length));
  }
  if (target.minRarity === "legendary") {
    notes.push("legendary rarity cannot be reached via Epic Souldust upgrade — it is drop-only.");
  }

  const finalRank = Math.min(requiredRank, maxRank);
  const tiersNeeded = Math.max(0, finalRank - currentRank);
  const epicSouldust = tiersNeeded * RARITY_UPGRADE_COST;

  let rerolls5Mark = 0;
  let legendarySouldust = 0;

  // --- modifier slots ---
  for (let i = 0; i < (target.modifierSlots?.length ?? 0); i++) {
    const wanted = target.modifierSlots[i];
    if (!wanted) continue;
    const existing = current.modifierSlots[i];

    // Slot i doesn't exist on the current item yet: it will be created by the
    // rarity upgrade above (fresh roll for slot 0, flooded duplicate of an
    // earlier slot for slots 1/2). Either way its landed category isn't
    // guaranteed to match, so treat it like a wrong-category slot below.
    const landedCategory = existing ? existing.category : undefined;

    if (landedCategory === wanted.category) {
      if (wanted.modifierId && existing.modifierId !== wanted.modifierId) {
        rerolls5Mark += MODIFIER_CATEGORIES[wanted.category].poolSize;
      }
    } else {
      if (!REROLLABLE_CATEGORIES.includes(wanted.category)) {
        notes.push(`modifier slot ${i}: category "${wanted.category}" is fixed/locked and cannot be rerolled onto.`);
        continue;
      }
      legendarySouldust += EXPECTED_LEGENDARY_REROLLS_TO_CATEGORY;
      if (wanted.modifierId) {
        rerolls5Mark += MODIFIER_CATEGORIES[wanted.category].poolSize;
      }
    }
  }

  // --- random stats: no documented reroll mechanism for stat *type* exists,
  // only for modifier-slot categories. Flag unresolved wants instead of
  // fabricating a cost. ---
  const currentStatTypes = current.randomStats.map((r) => r.stat);
  const unresolvedRandomStats = (target.randomStats ?? []).filter((s) => !currentStatTypes.includes(s));
  if (unresolvedRandomStats.length) {
    notes.push(`random stat type(s) [${unresolvedRandomStats.join(", ")}] cannot be targeted by any known reroll mechanic.`);
  }

  // --- trait tree path: rolled on drop, not rerollable. Feasibility check only. ---
  let traitPathAchievable;
  if (target.traitPath) {
    traitPathAchievable = isTraitPathReachable(target.traitPath);
    if (!traitPathAchievable) {
      notes.push("target traitPath is not reachable through the trait tree lattice.");
    } else if (current.traitTree && !pathIsPrefixCompatible(current.traitTree.chosen, target.traitPath)) {
      traitPathAchievable = false;
      notes.push("current item's already-chosen trait tiers conflict with target traitPath; requires a new item drop.");
    }
  }

  // --- neck attunements: reroll cost is unresearched (TBD), so we count
  // expected reroll attempts but do not fold it into totalMarks. ---
  let neckRerolls = 0;
  if (target.neckWanted?.length) {
    const chosen = current.neckAttunements?.chosen ?? [];
    const shownPerReroll = NECK_ATTUNEMENT_ROWS * NECK_ATTUNEMENT_OPTIONS_PER_ROW;
    for (const wanted of target.neckWanted) {
      if (!chosen.includes(wanted)) {
        neckRerolls += NECK_ATTUNEMENT_POOL_SIZE / shownPerReroll;
      }
    }
    notes.push("neck attunement reroll Marks cost is unresearched (TBD) — excluded from totalMarks.");
  }

  const rerolls10Mark = 0; // Not currently chosen by this calculator: identical expected cost to 5 Mark.
  const totalMarks = epicSouldust + rerolls5Mark * 5 + rerolls10Mark * 10;

  return {
    epicSouldust,
    rerolls5Mark,
    rerolls10Mark,
    legendarySouldust,
    neckRerolls,
    totalMarks,
    traitPathAchievable,
    notes,
  };
}

// Does `chosen` (current tree's already-locked-in choices, null = not yet
// chosen) agree with `path` (target) everywhere `chosen` is non-null?
function pathIsPrefixCompatible(chosen, path) {
  for (let i = 0; i < chosen.length; i++) {
    if (chosen[i] !== null && path[i] !== null && chosen[i] !== path[i]) return false;
  }
  return true;
}

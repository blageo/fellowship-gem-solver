// Sanity/regression tests for the gear system data model + upgrade cost
// calculator. Plain assertions, no test framework — same spirit as
// tools/parity.mjs, run with `node tools/gear_test.mjs`.

import assert from "node:assert/strict";
import { makeGearItem, makeTargetGearItem, isTraitPathReachable } from "../gear-model.js";
import { computeUpgradeCost } from "../gear-upgrade-cost.js";
import { EXPECTED_REROLL_MARKS, RARITY_UPGRADE_COST } from "../gear-constants.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- expected reroll costs match the handoff doc's worked numbers ---------
check("expected reroll cost: Major/Heroic/Defensive Trait = 45 Marks", () => {
  assert.equal(EXPECTED_REROLL_MARKS.majorTrait, 45);
  assert.equal(EXPECTED_REROLL_MARKS.heroicTrait, 45);
  assert.equal(EXPECTED_REROLL_MARKS.defensiveTrait, 45);
});
check("expected reroll cost: Blessing = 70 Marks", () => {
  assert.equal(EXPECTED_REROLL_MARKS.blessing, 70);
});
check("expected reroll cost: Gem Essence = 30 Marks", () => {
  assert.equal(EXPECTED_REROLL_MARKS.gemEssence, 30);
});
check("rarity upgrade cost is 15 Marks/tier; green->red = 60 Marks minimum", () => {
  assert.equal(RARITY_UPGRADE_COST, 15);
  const green = makeGearItem({
    id: "1", name: "Test Helm", slot: "helm", itemType: "normal",
    rarity: "green", league: "contender", randomStats: [{ stat: "stamina" }],
  });
  const target = makeTargetGearItem({ minRarity: "red" });
  const cost = computeUpgradeCost(green, target);
  assert.equal(cost.epicSouldust, 60);
});

// --- modifier slot: matching category, wrong modifierId -------------------
check("same-category wrong-modifierId reroll costs poolSize * 5 Marks, no legendary", () => {
  const item = makeGearItem({
    id: "2", name: "Test Chest", slot: "chest", itemType: "normal",
    rarity: "blue", league: "contender",
    randomStats: [{ stat: "stamina" }],
    modifierSlots: [{ category: "blessing", modifierId: "current-blessing" }],
  });
  const target = makeTargetGearItem({
    modifierSlots: [{ category: "blessing", modifierId: "wanted-blessing" }],
  });
  const cost = computeUpgradeCost(item, target);
  assert.equal(cost.legendarySouldust, 0);
  assert.equal(cost.rerolls5Mark, 14); // blessing pool size
  assert.equal(cost.totalMarks, 70);
});

// --- modifier slot: wrong category needs legendary souldust ---------------
check("wrong-category slot needs expected legendary rerolls to reach it", () => {
  const item = makeGearItem({
    id: "3", name: "Test Gloves", slot: "gloves", itemType: "normal",
    rarity: "blue", league: "contender",
    randomStats: [{ stat: "stamina" }],
    modifierSlots: [{ category: "gemEssence", modifierId: "ruby" }],
  });
  const target = makeTargetGearItem({
    modifierSlots: [{ category: "blessing" }], // category only, no specific modifierId
  });
  const cost = computeUpgradeCost(item, target);
  assert.equal(cost.legendarySouldust, 5); // 6 reachable categories - 1
  assert.equal(cost.rerolls5Mark, 0); // no modifierId requested, so no follow-up reroll
});

// --- random stat type has no known correction mechanism --------------------
check("wanted random stat not present is flagged, not costed", () => {
  const item = makeGearItem({
    id: "4", name: "Test Ring", slot: "ring_1", itemType: "normal",
    rarity: "green", league: "contender", randomStats: [{ stat: "stamina" }],
  });
  const target = makeTargetGearItem({ randomStats: ["haste"] });
  const cost = computeUpgradeCost(item, target);
  assert.ok(cost.notes.some((n) => n.includes("haste")));
});

// --- trait tree lattice reachability ----------------------------------------
check("trait tree: valid lattice path is reachable", () => {
  assert.equal(isTraitPathReachable([0, 1, 1, 1, 0]), true);
});
check("trait tree: disconnected path is rejected", () => {
  assert.equal(isTraitPathReachable([0, 0, 1, 0, 0]), false); // tier0->tier1 left only reaches {0,1}, ok; tier1(0)->tier2 reaches {0} only, 1 invalid
});

console.log(`\n${passed} checks passed.`);

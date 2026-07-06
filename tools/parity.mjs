// Parity harness: JS port (solver.js + highs-js) vs Python oracle (gem_solver.py
// via oracle.py, scipy/HiGHS). Generates random cases, solves both, and asserts
// total_marks is exactly equal and — thanks to the shared TIE_EPS tie-breaker —
// the full plan (shopping list, farm/seed lists, per-color Smalls, ordered steps)
// matches too.
//
//   PYTHON=/path/to/venv/bin/python3 node tools/parity.mjs [--n 300] [--seed 1]
//
// Exits non-zero if any total_marks mismatches (hard failure) or if full-plan
// mismatches exceed 0 (reported; tie-break should make these zero).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import highsLoader from "highs";
import { makeGrid, solve, planToDict, COLORS, TIERS } from "../solver.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// --- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const N = parseInt(argVal("--n", "300"), 10);
const SEED = parseInt(argVal("--seed", "12345"), 10);

// --- seeded RNG (mulberry32) ---------------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const randint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // inclusive
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// --- random case generator ------------------------------------------------
function randGrid(minEntries, maxEntries, maxCount, tierBias) {
  const entries = {};
  const n = randint(minEntries, maxEntries);
  for (let i = 0; i < n; i++) {
    const color = pick(COLORS);
    // tierBias: null = uniform; "high" leans to splendid/flawless
    const tier = tierBias === "high" ? pick([1, 2, 2, 3, 3]) : randint(0, 3);
    const key = `${color}_${TIERS[tier]}`;
    entries[key] = (entries[key] || 0) + randint(1, maxCount);
  }
  return entries;
}

function makeCase() {
  return {
    target: randGrid(1, 4, 4, rand() < 0.5 ? "high" : null),
    have: randGrid(0, 5, 6, null),
    small_cost: rand() < 0.5 ? 0 : 10,
    fewest_clicks: rand() < 0.5,
  };
}

// --- deep compare (objects order-independent, arrays ordered) -------------
function deepEqual(a, b, pathStr = "") {
  if (a === b) return null;
  if (typeof a === "number" && typeof b === "number") {
    return a === b ? null : `${pathStr}: ${a} !== ${b}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${pathStr}: array/non-array`;
    if (a.length !== b.length) return `${pathStr}: length ${a.length} !== ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = deepEqual(a[i], b[i], `${pathStr}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const d = deepEqual(a[k], b[k], pathStr ? `${pathStr}.${k}` : k);
      if (d) return d;
    }
    return null;
  }
  return `${pathStr}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
}

// --- run ------------------------------------------------------------------
const cases = Array.from({ length: N }, makeCase);

const python = process.env.PYTHON || "python3";
const proc = spawnSync(python, [path.join(HERE, "oracle.py")], {
  input: JSON.stringify(cases),
  encoding: "utf-8",
  maxBuffer: 1 << 28,
});
if (proc.status !== 0) {
  console.error("oracle.py failed:\n", proc.stderr || proc.stdout);
  process.exit(2);
}
const oracle = JSON.parse(proc.stdout);

const highs = await highsLoader();

let marksMismatch = 0;
let planMismatch = 0;
const firstFailures = [];

for (let i = 0; i < cases.length; i++) {
  const cs = cases[i];
  const plan = solve(highs, makeGrid(cs.target), makeGrid(cs.have), cs.small_cost);
  plan.bud_mode = cs.fewest_clicks ? "fewest" : "mono";
  const js = planToDict(plan);
  const py = oracle[i];

  // hard: total_marks exact, and resources.marks == total_marks (both engines)
  if (js.total_marks !== py.total_marks) {
    marksMismatch++;
    if (firstFailures.length < 5) firstFailures.push({ i, cs, why: `total_marks ${js.total_marks} (js) vs ${py.total_marks} (py)` });
    continue;
  }
  if (js.resources.marks !== js.total_marks) {
    marksMismatch++;
    if (firstFailures.length < 5) firstFailures.push({ i, cs, why: `js resources.marks ${js.resources.marks} != total ${js.total_marks}` });
    continue;
  }

  // strong: full plan parity (shopping list, farm/seed, smalls, steps)
  const diff = deepEqual(js, py);
  if (diff) {
    planMismatch++;
    if (firstFailures.length < 5) firstFailures.push({ i, cs, why: diff });
  }
}

console.log(`cases: ${N}  seed: ${SEED}`);
console.log(`total_marks mismatches : ${marksMismatch}`);
console.log(`full-plan mismatches   : ${planMismatch}`);
if (firstFailures.length) {
  console.log("\nfirst failures:");
  for (const f of firstFailures) {
    console.log(`  #${f.i}  ${f.why}`);
    console.log(`     case: ${JSON.stringify(f.cs)}`);
  }
}

if (marksMismatch > 0) {
  console.error("\nFAIL: total_marks parity broken.");
  process.exit(1);
}
if (planMismatch > 0) {
  console.error("\nWARN: total_marks parity holds, but full-plan parity has mismatches (tie-break gaps).");
  process.exit(1);
}
console.log("\nPASS: exact parity (total_marks + full plan) on all cases.");

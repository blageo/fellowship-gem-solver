// Fellowship (EAS3) gem fusion cost solver — environment-agnostic core.
//
// A faithful port of gem_solver.py. The MILP is emitted as a CPLEX LP-format
// string and handed to a HiGHS instance (highs-js) supplied by the caller, so
// this module runs unchanged in the browser (app.js) and in Node (parity
// harness). HiGHS is the same engine scipy.optimize.milp uses, so results match
// the Python oracle exactly — including the full shopping list, thanks to the
// TIE_EPS tie-breaker below.

// --- game constants -------------------------------------------------------
export const COLORS = ["ruby", "amethyst", "topaz", "emerald", "sapphire", "diamond"];
export const TIERS = ["small", "large", "splendid", "flawless"]; // index 0..3
export const T = Object.fromEntries(TIERS.map((name, i) => [name, i]));

export const FUSE_COST = { 0: 5, 1: 10, 2: 15 }; // aether marks for tier t -> t+1
export const TRANSMUTE_COST = 15;                // arcane, guaranteed targeted
export const GODSTONE_COST = { defender: 5, hero: 10, legend: 15 };
export const DEFAULT_SMALL_COST = 10;            // bud cost per extra small (aether + godstone)

// Lexicographic tie-breaker on transmute variables; mirrors gem_solver.py. Marks
// are integer multiples of 5, so these tiny per-transmute weights never trade a
// genuine Marks saving — they only pick among equal-Marks optima:
//   * TRANS_TIE_BASE per transmute penalises transmuting, so the solver never
//     "builds a wrong colour then transmutes" and salvage transmutes stay minimal;
//   * TRANS_TIE_STEP * (enumeration index) gives every transmute variable a
//     distinct cost, so a salvaged gem's *destination* colour is chosen
//     deterministically — the sole remaining source of tied optima. This makes
//     the whole plan (not just the total) match the Python oracle, which uses the
//     same weights and the same HiGHS engine.
// Weights live only on the ~120 transmute variables (never the large bud counts),
// and BASE + 119*STEP stays far below the 5-Mark minimum gap for any realistic
// transmute count. total_marks is recomputed from the decoded plan, so these
// weights never leak into the reported total.
export const TRANS_TIE_BASE = 0.02;
export const TRANS_TIE_STEP = 1e-4;

// gem display colors for the UI
export const GEM_HEX = {
  ruby: "#e2445c", amethyst: "#a259d9", topaz: "#e0a11b",
  emerald: "#35c26b", sapphire: "#3d7fe0", diamond: "#cfd8e6",
};

// closed-form "build one gem of any color from scratch" marks cost. color-agnostic.
export function scratchUnitCost(tier, smallCost = DEFAULT_SMALL_COST) {
  const smalls = 3 ** tier;
  const aether = { 0: 0, 1: 5, 2: 25, 3: 90 }[tier]; // cumulative fusion aether
  return smalls * smallCost + aether;
}

// Split N Smalls-to-bud into bud actions.
//   'mono'   : N monobuds (exact, most clicks)
//   'fewest' : as many triple buds as possible, then one double/mono (ceil(N/3))
export function budDecompose(n, mode = "mono") {
  if (n <= 0) return { triple: 0, double: 0, mono: 0 };
  if (mode === "fewest") {
    const triple = Math.floor(n / 3);
    const rem = n % 3;
    return { triple, double: rem === 2 ? 1 : 0, mono: rem === 1 ? 1 : 0 };
  }
  return { triple: 0, double: 0, mono: n };
}

// --- inventory / target grids --------------------------------------------
export function emptyGrid() {
  const g = {};
  for (const c of COLORS) g[c] = { 0: 0, 1: 0, 2: 0, 3: 0 };
  return g;
}

// Build a grid from {color_tier: n} entries, e.g. {sapphire_flawless: 2}.
export function makeGrid(entries = {}) {
  const g = emptyGrid();
  for (const [key, n] of Object.entries(entries)) {
    const i = key.lastIndexOf("_");
    const color = key.slice(0, i);
    const tier = key.slice(i + 1);
    if (!COLORS.includes(color)) throw new Error(`unknown color ${color}`);
    if (!(tier in T)) throw new Error(`unknown tier ${tier}`);
    g[color][T[tier]] = n;
  }
  return g;
}

// --- LP model -------------------------------------------------------------
// Variable names, in the same order as gem_solver.py's variable layout:
//   bud   b_<color>
//   fuse  f_<color>_<t>        t in 0..2
//   trans x_<from>_<to>_<t>    from != to, t in 0..3
const budVar = (c) => `b_${c}`;
const fuseVar = (c, t) => `f_${c}_${t}`;
const transVar = (a, b, t) => `x_${a}_${b}_${t}`;

function allVarNames() {
  const names = [];
  for (const c of COLORS) names.push(budVar(c));
  for (const c of COLORS) for (let t = 0; t < 3; t++) names.push(fuseVar(c, t));
  for (const a of COLORS) for (const b of COLORS) {
    if (a === b) continue;
    for (let t = 0; t < 4; t++) names.push(transVar(a, b, t));
  }
  return names;
}

// Emit the CPLEX LP-format problem string for (target, inventory, smallCost).
export function buildLP(target, inventory, smallCost) {
  // objective: minimize marks + TIE_EPS * (# transmutes)
  const objTerms = [];
  const pushObj = (coef, name) => { if (coef !== 0) objTerms.push(`${coef} ${name}`); };
  for (const c of COLORS) pushObj(smallCost, budVar(c));
  for (const c of COLORS) for (let t = 0; t < 3; t++) pushObj(FUSE_COST[t], fuseVar(c, t));
  let tj = 0; // transmute enumeration index, for the deterministic tie-break
  for (const a of COLORS) for (const b of COLORS) {
    if (a === b) continue;
    for (let t = 0; t < 4; t++) {
      pushObj(TRANSMUTE_COST + TRANS_TIE_BASE + tj * TRANS_TIE_STEP, transVar(a, b, t));
      tj++;
    }
  }

  // constraints: for each (c,t)  uses - supply <= owned - demand
  const consLines = [];
  for (const c of COLORS) {
    for (let t = 0; t < 4; t++) {
      const coef = new Map();
      const add = (name, v) => coef.set(name, (coef.get(name) || 0) + v);
      if (t === 0) add(budVar(c), -1);           // bud adds small supply
      if (t >= 1) add(fuseVar(c, t - 1), -1);      // fused up from below: supply
      if (t <= 2) add(fuseVar(c, t), 3);           // fusing up consumes 3
      for (const other of COLORS) {
        if (other === c) continue;
        add(transVar(other, c, t), -1);            // into c: supply
        add(transVar(c, other, t), 1);             // out of c: use
      }
      const bval = inventory[c][t] - target[c][t];
      consLines.push(` c_${c}_${t}: ${formatTerms(coef)} <= ${bval}`);
    }
  }

  const lp = [
    "Minimize",
    ` obj: ${objTerms.join(" + ")}`,
    "Subject To",
    ...consLines,
    "General",
    ` ${allVarNames().join(" ")}`,
    "End",
    "",
  ].join("\n");
  return lp;
}

// Format a coefficient map into signed LP terms, e.g. "- b_ruby + 3 f_ruby_0".
function formatTerms(coef) {
  const parts = [];
  for (const [name, v] of coef) {
    if (v === 0) continue;
    const sign = v < 0 ? "-" : "+";
    const mag = Math.abs(v);
    parts.push(mag === 1 ? `${sign} ${name}` : `${sign} ${mag} ${name}`);
  }
  return parts.length ? parts.join(" ") : "0 " + coef.keys().next().value;
}

// --- solve ----------------------------------------------------------------
// `highs` is a resolved highs-js instance. Returns a plan object mirroring the
// Python Plan dataclass. smallCost 0 => Smalls treated as free-farmed.
export function solve(highs, target, inventory, smallCost = DEFAULT_SMALL_COST) {
  const lp = buildLP(target, inventory, smallCost);
  // gap 0 so the TIE_EPS secondary objective is proven-optimal, not left ambiguous
  // within HiGHS's default MIP gap; output off; fixed seed for determinism.
  const sol = highs.solve(lp, { mip_rel_gap: 0, mip_abs_gap: 0, output_flag: false, random_seed: 0 });
  if (sol.Status !== "Optimal") throw new Error(`solver failed: ${sol.Status}`);

  const val = (name) => Math.round(sol.Columns[name].Primal);

  const buds = {};
  for (const c of COLORS) buds[c] = val(budVar(c));
  const fuses = {}; // key `${c},${t}` -> n
  for (const c of COLORS) for (let t = 0; t < 3; t++) fuses[`${c},${t}`] = val(fuseVar(c, t));
  const transmutes = {}; // key `${a},${b},${t}` -> n
  for (const a of COLORS) for (const b of COLORS) {
    if (a === b) continue;
    for (let t = 0; t < 4; t++) transmutes[`${a},${b},${t}`] = val(transVar(a, b, t));
  }

  const sumFuse = (t) => COLORS.reduce((s, c) => s + fuses[`${c},${t}`], 0);
  const aether = { unstable: sumFuse(0), imbued: sumFuse(1), arcane_fuse: sumFuse(2) };

  // small gems consumed per color (owned + budded), mirrors gem_solver.py
  const small_gems = {};
  for (const c of COLORS) {
    let transInSmall = 0, transOutSmall = 0;
    for (const o of COLORS) {
      if (o === c) continue;
      transInSmall += transmutes[`${o},${c},0`];
      transOutSmall += transmutes[`${c},${o},0`];
    }
    const supply0 = inventory[c][0] + buds[c] + transInSmall;
    const left0 = supply0 - target[c][0] - 3 * fuses[`${c},0`] - transOutSmall;
    small_gems[c] = supply0 - Math.max(left0, 0);
  }

  // leftovers at every (c,t)
  const leftover = {}; // key `${c},${t}` -> surplus
  for (const c of COLORS) {
    for (let t = 0; t < 4; t++) {
      let supply = inventory[c][t];
      if (t === 0) supply += buds[c];
      if (t >= 1) supply += fuses[`${c},${t - 1}`];
      let uses = target[c][t];
      if (t <= 2) uses += 3 * fuses[`${c},${t}`];
      for (const o of COLORS) {
        if (o === c) continue;
        supply += transmutes[`${o},${c},${t}`];
        uses += transmutes[`${c},${o},${t}`];
      }
      const surplus = supply - uses;
      if (surplus > 0) leftover[`${c},${t}`] = surplus;
    }
  }

  // total from the decoded plan with the real costs (no TIE_EPS leak)
  let total_marks = 0;
  for (const c of COLORS) total_marks += buds[c] * smallCost;
  for (const c of COLORS) for (let t = 0; t < 3; t++) total_marks += fuses[`${c},${t}`] * FUSE_COST[t];
  for (const k in transmutes) total_marks += transmutes[k] * TRANSMUTE_COST;

  return {
    total_marks, buds, fuses, transmutes, aether, small_gems, leftover,
    small_cost: smallCost, bud_mode: "mono",
  };
}

// --- post-solve derivations (mirror the Plan methods) ---------------------
export function breakdown(plan) {
  const budMarks = Object.values(plan.buds).reduce((a, b) => a + b, 0) * plan.small_cost;
  const fuseMarks = plan.aether.unstable * FUSE_COST[0]
    + plan.aether.imbued * FUSE_COST[1]
    + plan.aether.arcane_fuse * FUSE_COST[2];
  const transMarks = Object.values(plan.transmutes).reduce((a, b) => a + b, 0) * TRANSMUTE_COST;
  return { budding: budMarks, fusion_aether: fuseMarks, transmutation: transMarks };
}

export function resources(plan) {
  const fu_uns = plan.aether.unstable;
  const fu_imb = plan.aether.imbued;
  const fu_arc = plan.aether.arcane_fuse;
  const trans_arc = Object.values(plan.transmutes).reduce((a, b) => a + b, 0);

  let bud_uns = 0, bud_imb = 0, bud_arc = 0;
  let defender = 0, hero = 0, legend = 0;
  let farm_smalls = {};
  const seed_smalls = [];

  if (plan.small_cost === 0) {
    for (const [c, n] of Object.entries(plan.buds)) if (n) farm_smalls[c] = n;
  } else {
    for (const c of COLORS) {
      const n = plan.buds[c];
      if (n <= 0) continue;
      const d = budDecompose(n, plan.bud_mode);
      bud_uns += d.mono; defender += d.mono;
      bud_imb += d.double; hero += d.double;
      bud_arc += d.triple; legend += d.triple;
      if ((plan.small_gems[c] || 0) - n === 0) seed_smalls.push(c); // own zero of this color
    }
  }

  const unstable = fu_uns + bud_uns;
  const imbued = fu_imb + bud_imb;
  const arcane = fu_arc + trans_arc + bud_arc;
  const marks = 5 * unstable + 10 * imbued + 15 * arcane
    + GODSTONE_COST.defender * defender
    + GODSTONE_COST.hero * hero
    + GODSTONE_COST.legend * legend;
  return {
    unstable: { fuse: fu_uns, bud: bud_uns, total: unstable },
    imbued: { fuse: fu_imb, bud: bud_imb, total: imbued },
    arcane: { fuse: fu_arc, transmute: trans_arc, bud: bud_arc, total: arcane },
    godstones: { defender, hero, legend },
    marks,
    farm_smalls,
    seed_smalls,
  };
}

// Operations in a valid in-game execution order:
//   1. bud all Smalls (or farm, in free mode)
//   2. for each tier low->high: transmute at that tier, then fuse it upward
export function orderedSteps(plan) {
  const steps = [];
  const buds = COLORS.filter((c) => plan.buds[c]).map((c) => [c, plan.buds[c]]);
  if (buds.length) {
    if (plan.small_cost === 0) {
      steps.push({ kind: "farm", items: buds.map(([c, n]) => ({ color: c, n })) });
    } else {
      steps.push({
        kind: "bud",
        items: buds.map(([c, n]) => ({ color: c, n, actions: budDecompose(n, plan.bud_mode) })),
      });
    }
  }
  for (let t = 0; t < 4; t++) {
    const tr = [];
    for (const a of COLORS) for (const b of COLORS) {
      if (a === b) continue;
      const n = plan.transmutes[`${a},${b},${t}`];
      if (n) tr.push({ from: a, to: b, n });
    }
    if (tr.length) {
      tr.sort((p, q) => (p.from < q.from ? -1 : p.from > q.from ? 1 : p.to < q.to ? -1 : p.to > q.to ? 1 : 0));
      steps.push({ kind: "transmute", tier: t, items: tr });
    }
    if (t < 3) {
      const fu = [];
      for (const c of COLORS) {
        const n = plan.fuses[`${c},${t}`];
        if (n) fu.push({ color: c, n });
      }
      if (fu.length) {
        fu.sort((p, q) => (p.color < q.color ? -1 : p.color > q.color ? 1 : 0));
        steps.push({ kind: "fuse", tier: t, items: fu });
      }
    }
  }
  return steps;
}

// JSON-friendly bundle for rendering (mirrors gem_app.plan_to_dict).
export function planToDict(plan) {
  const smalls = [];
  for (const c of COLORS) {
    const total = plan.small_gems[c] || 0;
    if (total) {
      const to_get = plan.buds[c] || 0;
      smalls.push({ color: c, total, owned: total - to_get, to_get });
    }
  }
  const leftover = [];
  for (const [key, n] of Object.entries(plan.leftover)) {
    if (!n) continue;
    const [c, t] = key.split(",");
    leftover.push({ color: c, tier: TIERS[+t], n });
  }
  const steps = orderedSteps(plan).map((s) => {
    const out = { ...s };
    if ("tier" in out) {
      out.tier_name = TIERS[out.tier];
      if (out.kind === "fuse") out.to_name = TIERS[out.tier + 1];
    }
    return out;
  });
  return {
    total_marks: plan.total_marks,
    breakdown: breakdown(plan),
    resources: resources(plan),
    steps,
    smalls,
    leftover,
  };
}

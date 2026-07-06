"""
Fellowship (Early Access Season 3) — gem fusion cost solver.

Models the three ways to obtain a specific gem and finds the minimum-Marks plan
to reach a target inventory from what you currently own.

Operations
----------
Fuse       3 gems of (color, tier) + 1 aether -> 1 gem of (color, tier+1)
             small->large    : 1 Unstable Aether  (5 Marks)
             large->splendid : 1 Imbued Aether     (10 Marks)
             splendid->flaw. : 1 Arcane Aether      (15 Marks)
Bud        1 seed Small (survives) -> +N extra Smalls of the SAME color
             1 Aether + 1 Godstone per bud action:
               monobud  (+1): Unstable + Defender's Godstone  = 10 Marks
               doublebud(+2): Imbued   + Hero's Godstone       = 20 (10/gem)
               triplebud(+3): Arcane   + Legend's Godstone      = 30 (10/gem)
             -> a flat 10 Marks per Small gained
Transmute  1 gem of (any color, tier) -> 1 gem of (chosen color, SAME tier)
             Arcane, targeted, guaranteed: 15 Marks (the only route the solver uses,
             since Unstable/Imbued average 25 Marks to hit a specific color)

Assumptions (stated explicitly so they're easy to change later)
--------------------------------------------------------------
* Currently-owned gems are free (already farmed / sunk cost).
* Budding is always available at `small_cost` Marks per Small (default 5). This
  assumes you can farm/hold at least one seed of any color you want to bud.
  Set small_cost=0 to treat Small gems as free-but-farmed and read `buds` as
  "raw Small gems to acquire".
* Aether is priced via the vendor (5 / 10 / 15 Marks). If you craft/drop aether
  instead, edit FUSE_COST / TRANSMUTE_COST.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds

# --- game constants -------------------------------------------------------
COLORS = ["ruby", "amethyst", "topaz", "emerald", "sapphire", "diamond"]
TIERS = ["small", "large", "splendid", "flawless"]   # index 0..3
T = {name: i for i, name in enumerate(TIERS)}

FUSE_COST = {0: 5, 1: 10, 2: 15}   # aether marks for tier t -> t+1
TRANSMUTE_COST = 15                 # arcane, guaranteed targeted

# Lexicographic tie-breaker on transmute variables. Marks costs are integer
# multiples of 5, so these tiny secondary weights never trade a genuine Marks
# saving — they only choose among the many equal-Marks optima:
#   * TRANS_TIE_BASE per transmute penalises transmuting, so the solver never
#     "builds a wrong colour then transmutes" and salvage transmutes stay minimal;
#   * TRANS_TIE_STEP * (enumeration index) gives every transmute variable a
#     distinct cost, so a salvaged gem's *destination* colour is chosen
#     deterministically — the sole remaining source of tied optima.
# This makes the chosen plan deterministic and lets Python (scipy/HiGHS) and JS
# (highs-js) — the same engine, same weights — agree on the full shopping list,
# not just the total. Weights live only on the ~120 transmute variables (never the
# large bud counts), and BASE + 119*STEP stays far below the 5-Mark minimum gap
# for any realistic transmute count. total_marks is recomputed from the decoded
# integer plan, so these weights never leak into it.
TRANS_TIE_BASE = 0.02
TRANS_TIE_STEP = 1e-4

# Budding a Small needs BOTH an Aether and a Godstone:
#   monobud  (+1): Unstable Aether (5) + Defender's Godstone (5) = 10
#   doublebud(+2): Imbued Aether  (10) + Hero's Godstone     (10) = 20  (10/gem)
#   triplebud(+3): Arcane Aether  (15) + Legend's Godstone   (15) = 30  (10/gem)
# All sizes cost 10 Marks per Small gained, so budding cost = 10/gem.
GODSTONE_COST = {"defender": 5, "hero": 10, "legend": 15}
DEFAULT_SMALL_COST = 10            # bud cost per extra small (aether + godstone)

# closed-form "build one gem of any color from scratch" marks cost,
# = smalls_needed * small_cost + fusion aether. color-agnostic.
def scratch_unit_cost(tier: int, small_cost: int = DEFAULT_SMALL_COST) -> int:
    smalls = 3 ** tier
    aether = {0: 0, 1: 5, 2: 25, 3: 90}[tier]   # cumulative fusion aether
    return smalls * small_cost + aether


def bud_decompose(n: int, mode: str = "mono") -> dict:
    """
    Split N Smalls-to-bud into bud actions.
      mode 'mono'   : N monobuds (exact, most clicks)
      mode 'fewest' : as many triple buds as possible, then one double/mono
                      for the remainder — ceil(N/3) actions, still exact.
    Each action: mono=+1 (Unstable+Defender), double=+2 (Imbued+Hero),
    triple=+3 (Arcane+Legend).
    """
    if n <= 0:
        return {"triple": 0, "double": 0, "mono": 0}
    if mode == "fewest":
        triple, rem = divmod(n, 3)
        return {"triple": triple,
                "double": 1 if rem == 2 else 0,
                "mono": 1 if rem == 1 else 0}
    return {"triple": 0, "double": 0, "mono": n}


# --- inventory / target types --------------------------------------------
def _grid():
    """dict[color][tier] = 0 for all."""
    return {c: {t: 0 for t in range(4)} for c in COLORS}

def make(**entries) -> dict:
    """
    Build an inventory/target grid.
    Keys are 'color_tier', e.g. sapphire_flawless=2, ruby_small=27.
    """
    g = _grid()
    for key, n in entries.items():
        color, tier = key.rsplit("_", 1)
        if color not in COLORS:
            raise ValueError(f"unknown color {color!r}")
        if tier not in T:
            raise ValueError(f"unknown tier {tier!r}")
        g[color][T[tier]] = n
    return g


@dataclass
class Plan:
    total_marks: int
    buds: dict                 # color -> extra smalls budded
    fuses: dict                # (color, tier) -> count of fusions at that tier
    transmutes: dict           # (from_color, to_color, tier) -> count
    aether: dict               # 'unstable'/'imbued'/'arcane' -> count used
    small_gems: dict           # color -> total small gems consumed (owned+budded)
    leftover: dict             # (color, tier) -> surplus gems left at the end
    small_cost: int
    bud_mode: str = "mono"     # 'mono' (exact) or 'fewest' (fewest clicks); display-only

    def breakdown(self) -> dict:
        bud_marks = sum(self.buds.values()) * self.small_cost
        fuse_marks = (self.aether["unstable"] * FUSE_COST[0]
                      + self.aether["imbued"] * FUSE_COST[1]
                      + self.aether["arcane_fuse"] * FUSE_COST[2])
        trans_marks = sum(self.transmutes.values()) * TRANSMUTE_COST
        return {"budding": bud_marks, "fusion_aether": fuse_marks,
                "transmutation": trans_marks}

    def resources(self) -> dict:
        """
        Exact vendor shopping list: Aether + Godstones to buy, split by use.

        Budding a Small costs 1 Aether + 1 Godstone of the matching size and a
        flat 10 Marks/gem. bud_mode chooses how bud actions are batched:
          'mono'   -> all monobuds (Unstable + Defender's Godstone)
          'fewest' -> triple buds (Arcane + Legend's) where possible, remainder
                      filled with one double/mono; same Marks, fewest clicks.
        When small_cost == 0 the Smalls are farmed instead, costing nothing here.
        """
        fu_uns = self.aether["unstable"]
        fu_imb = self.aether["imbued"]
        fu_arc = self.aether["arcane_fuse"]
        trans_arc = sum(self.transmutes.values())

        bud_uns = bud_imb = bud_arc = 0          # aether used for budding
        defender = hero = legend = 0
        farm_smalls, seed_smalls = {}, []

        if self.small_cost == 0:
            farm_smalls = {c: n for c, n in self.buds.items() if n}
        else:
            for c, n in self.buds.items():
                if n <= 0:
                    continue
                d = bud_decompose(n, self.bud_mode)
                bud_uns += d["mono"];   defender += d["mono"]
                bud_imb += d["double"]; hero += d["double"]
                bud_arc += d["triple"]; legend += d["triple"]
                if self.small_gems.get(c, 0) - n == 0:   # own zero of this color
                    seed_smalls.append(c)

        unstable = fu_uns + bud_uns
        imbued = fu_imb + bud_imb
        arcane = fu_arc + trans_arc + bud_arc
        marks = (5 * unstable + 10 * imbued + 15 * arcane
                 + GODSTONE_COST["defender"] * defender
                 + GODSTONE_COST["hero"] * hero
                 + GODSTONE_COST["legend"] * legend)
        return {
            "unstable": {"fuse": fu_uns, "bud": bud_uns, "total": unstable},
            "imbued": {"fuse": fu_imb, "bud": bud_imb, "total": imbued},
            "arcane": {"fuse": fu_arc, "transmute": trans_arc, "bud": bud_arc, "total": arcane},
            "godstones": {"defender": defender, "hero": hero, "legend": legend},
            "marks": marks,
            "farm_smalls": farm_smalls,
            "seed_smalls": seed_smalls,
        }

    def ordered_steps(self) -> list:
        """
        Operations in a valid in-game execution order:
          1. bud all Smalls
          2. for each tier low->high: transmute at that tier, then fuse it upward
        (transmute-before-fuse matters when a transmuted gem feeds a fusion; a
        fused gem that is then recolored shows up as a transmute at the next tier.)
        """
        steps = []
        buds = {c: n for c, n in self.buds.items() if n}
        if buds:
            if self.small_cost == 0:
                steps.append({"kind": "farm",
                              "items": [{"color": c, "n": n} for c, n in buds.items()]})
            else:
                steps.append({"kind": "bud",
                              "items": [{"color": c, "n": n,
                                         "actions": bud_decompose(n, self.bud_mode)}
                                        for c, n in buds.items()]})
        for t in range(4):
            tr = [{"from": fc, "to": tc, "n": n}
                  for (fc, tc, tt), n in self.transmutes.items() if tt == t and n]
            if tr:
                steps.append({"kind": "transmute", "tier": t,
                              "items": sorted(tr, key=lambda r: (r["from"], r["to"]))})
            if t < 3:
                fu = [{"color": c, "n": n}
                      for (c, tt), n in self.fuses.items() if tt == t and n]
                if fu:
                    steps.append({"kind": "fuse", "tier": t,
                                  "items": sorted(fu, key=lambda r: r["color"])})
        return steps

    def __str__(self) -> str:
        lines = [f"TOTAL: {self.total_marks} Marks"]
        bd = self.breakdown()
        lines.append(f"  budding {bd['budding']} | fusion aether {bd['fusion_aether']} "
                     f"| transmutation {bd['transmutation']}")

        lines.append("")
        lines.append(f"PLAN (in order)   [bud mode: {self.bud_mode}]")
        step_no = 0
        for s in self.ordered_steps():
            step_no += 1
            if s["kind"] == "bud":
                lines.append(f"  {step_no}. Bud Smalls:")
                for it in s["items"]:
                    a = it["actions"]
                    parts = []
                    if a["triple"]: parts.append(f"{a['triple']}x triple")
                    if a["double"]: parts.append(f"{a['double']}x double")
                    if a["mono"]:   parts.append(f"{a['mono']}x mono")
                    lines.append(f"       +{it['n']:<3d} {it['color']:9s}  ({', '.join(parts)})")
            elif s["kind"] == "farm":
                lines.append(f"  {step_no}. Farm Smalls: "
                             + ", ".join(f"{it['n']} {it['color']}" for it in s["items"]))
            elif s["kind"] == "fuse":
                t = s["tier"]
                lines.append(f"  {step_no}. Fuse {TIERS[t]} -> {TIERS[t+1]}:")
                for it in s["items"]:
                    lines.append(f"       {it['n']}x  3 {it['color']} {TIERS[t]} -> 1 {it['color']} {TIERS[t+1]}")
            elif s["kind"] == "transmute":
                t = s["tier"]
                lines.append(f"  {step_no}. Transmute {TIERS[t]} (Arcane):")
                for it in s["items"]:
                    lines.append(f"       {it['n']}x  {it['from']} -> {it['to']}")

        lo = {k: v for k, v in self.leftover.items() if v}
        if lo:
            lines.append("Leftover: "
                         + ", ".join(f"{v} {c} {TIERS[t]}" for (c, t), v in lo.items()))

        r = self.resources()
        lines.append("")
        lines.append(f"BUY AT VENDOR  ({r['marks']} Marks of Fellowship):")
        u, im, a, g = r["unstable"], r["imbued"], r["arcane"], r["godstones"]

        def _note(d, keys):
            bits = [f"{d[k]} {k}" for k in keys if d.get(k)]
            return f"  ({' + '.join(bits)})" if bits else ""

        if u["total"]:
            lines.append(f"    Unstable Aether  x{u['total']:<4d}" + _note(u, ["fuse", "bud"]))
        if im["total"]:
            lines.append(f"    Imbued Aether    x{im['total']:<4d}" + _note(im, ["fuse", "bud"]))
        if a["total"]:
            lines.append(f"    Arcane Aether    x{a['total']:<4d}" + _note(a, ["fuse", "transmute", "bud"]))
        if g["defender"]:
            lines.append(f"    Defender's Godstone x{g['defender']:<4d}  (monobud)")
        if g["hero"]:
            lines.append(f"    Hero's Godstone     x{g['hero']:<4d}  (double bud)")
        if g["legend"]:
            lines.append(f"    Legend's Godstone   x{g['legend']:<4d}  (triple bud)")
        if r["farm_smalls"]:
            lines.append("    Farm Small gems: "
                         + ", ".join(f"{n} {c}" for c, n in r["farm_smalls"].items()))
        if r["seed_smalls"]:
            lines.append("    Seed Smalls needed (1 each to start budding): "
                         + ", ".join(r["seed_smalls"]))
        return "\n".join(lines)


# --- the solver -----------------------------------------------------------
def solve(target: dict, inventory: dict | None = None,
          small_cost: int = DEFAULT_SMALL_COST) -> Plan:
    """
    Minimum-Marks plan to reach `target` counts given `inventory` on hand.
    Both are grids from make(...). Returns a Plan.
    """
    inv = inventory or _grid()

    # ---- variable layout (all integer >= 0) ----
    # bud[c]                          : 6
    # fuse[c,t]  t in 0,1,2           : 18
    # trans[a,b,t] a!=b, t in 0..3    : 6*5*4 = 120
    var = {}
    idx = 0
    def add(name):
        nonlocal idx
        var[name] = idx
        idx += 1

    for c in COLORS:
        add(("bud", c))
    for c in COLORS:
        for t in range(3):
            add(("fuse", c, t))
    for a in COLORS:
        for b in COLORS:
            if a == b:
                continue
            for t in range(4):
                add(("trans", a, b, t))
    n = idx

    # ---- objective (minimize marks) ----
    cost = np.zeros(n)
    for c in COLORS:
        cost[var[("bud", c)]] = small_cost
        for t in range(3):
            cost[var[("fuse", c, t)]] = FUSE_COST[t]
    tj = 0   # transmute enumeration index, for the deterministic tie-break
    for a in COLORS:
        for b in COLORS:
            if a == b:
                continue
            for t in range(4):
                cost[var[("trans", a, b, t)]] = (
                    TRANSMUTE_COST + TRANS_TIE_BASE + tj * TRANS_TIE_STEP)
                tj += 1

    # ---- constraints: supply(c,t) >= uses(c,t)  ->  A_ub x <= b_ub ----
    rows, bvals = [], []
    for c in COLORS:
        for t in range(4):
            row = np.zeros(n)
            # supply (negative in <=0 form, i.e. subtract): coefficient -1 for supply terms
            # uses (positive): +1 (or +3 for fusion consumption)
            # form: uses - supply <= owned - demand
            # bud adds small supply
            if t == 0:
                row[var[("bud", c)]] -= 1
            # fusion from below adds supply at tier t
            if t >= 1:
                row[var[("fuse", c, t - 1)]] -= 1
            # fusion up consumes 3 at tier t
            if t <= 2:
                row[var[("fuse", c, t)]] += 3
            # transmute in (b==c) adds supply; transmute out (a==c) consumes
            for other in COLORS:
                if other == c:
                    continue
                row[var[("trans", other, c, t)]] -= 1   # into c: supply
                row[var[("trans", c, other, t)]] += 1   # out of c: use
            rows.append(row)
            bvals.append(inv[c][t] - target[c][t])

    A = np.array(rows)
    constraints = [LinearConstraint(A, -np.inf, np.array(bvals))]

    integrality = np.ones(n)
    bounds = Bounds(lb=np.zeros(n), ub=np.full(n, np.inf))
    # gap 0 so the TIE_EPS secondary objective is actually proven-optimal, not
    # left ambiguous within HiGHS's default MIP gap tolerance.
    res = milp(c=cost, constraints=constraints, integrality=integrality,
               bounds=bounds, options={"mip_rel_gap": 0})
    if not res.success:
        raise RuntimeError(f"solver failed: {res.message}")

    x = np.round(res.x).astype(int)

    # ---- decode ----
    buds = {c: int(x[var[("bud", c)]]) for c in COLORS}
    fuses = {(c, t): int(x[var[("fuse", c, t)]])
             for c in COLORS for t in range(3)}
    transmutes = {(a, b, t): int(x[var[("trans", a, b, t)]])
                  for a in COLORS for b in COLORS if a != b for t in range(4)}

    aether = {
        "unstable": sum(fuses[(c, 0)] for c in COLORS),
        "imbued": sum(fuses[(c, 1)] for c in COLORS),
        "arcane_fuse": sum(fuses[(c, 2)] for c in COLORS),
    }

    # small gems consumed per color = owned smalls used + budded smalls,
    # which equals everything fused up out of small tier + demanded smalls kept,
    # minus leftovers. Simpler: smalls entering the color = owned + bud + trans_in(small);
    # report total smalls that flow (owned+budded) as "small gems used".
    small_used = {}
    for c in COLORS:
        trans_in_small = sum(transmutes[(o, c, 0)] for o in COLORS if o != c)
        supply0 = inv[c][0] + buds[c] + trans_in_small
        trans_out_small = sum(transmutes[(c, o, 0)] for o in COLORS if o != c)
        left0 = supply0 - target[c][0] - 3 * fuses[(c, 0)] - trans_out_small
        small_used[c] = supply0 - max(left0, 0)

    # leftovers at every (c,t)
    leftover = {}
    for c in COLORS:
        for t in range(4):
            supply = inv[c][t]
            if t == 0:
                supply += buds[c]
            if t >= 1:
                supply += fuses[(c, t - 1)]
            supply += sum(transmutes[(o, c, t)] for o in COLORS if o != c)
            uses = target[c][t]
            if t <= 2:
                uses += 3 * fuses[(c, t)]
            uses += sum(transmutes[(c, o, t)] for o in COLORS if o != c)
            surplus = supply - uses
            if surplus > 0:
                leftover[(c, t)] = surplus

    # recompute total from the decoded integer plan with the *real* costs, so the
    # TIE_EPS secondary weight in the objective never leaks into the reported total.
    total_marks = (sum(buds.values()) * small_cost
                   + sum(fuses[(c, t)] * FUSE_COST[t] for c in COLORS for t in range(3))
                   + sum(transmutes.values()) * TRANSMUTE_COST)

    return Plan(total_marks=total_marks, buds=buds, fuses=fuses,
                transmutes=transmutes, aether=aether, small_gems=small_used,
                leftover=leftover, small_cost=small_cost)


# --- command-line interface ----------------------------------------------
def _parse_kv(tokens):
    """Turn ['sapphire_flawless=2', 'ruby_small=9'] into make() kwargs."""
    kw = {}
    for tok in tokens or []:
        if "=" not in tok:
            raise SystemExit(
                f"bad token {tok!r} — expected color_tier=count, e.g. sapphire_flawless=2")
        key, val = tok.split("=", 1)
        try:
            kw[key] = int(val)
        except ValueError:
            raise SystemExit(f"count in {tok!r} must be a whole number")
    return kw


def _cli():
    import argparse
    p = argparse.ArgumentParser(
        prog="gem_solver.py",
        description="Fellowship (EAS3) gem fusion cost solver.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
colors : ruby amethyst topaz emerald sapphire diamond
tiers  : small large splendid flawless

examples:
  python3 gem_solver.py --demo
  python3 gem_solver.py --target sapphire_flawless=2 ruby_flawless=1
  python3 gem_solver.py --target sapphire_flawless=4 amethyst_flawless=2 \\
                        --have ruby_flawless=1 diamond_flawless=1 sapphire_splendid=5
  python3 gem_solver.py --target emerald_splendid=4 --small-cost 0
""")
    p.add_argument("--target", nargs="+", metavar="color_tier=N",
                   help="gems you want to end up with")
    p.add_argument("--have", nargs="+", metavar="color_tier=N", default=[],
                   help="gems you already own (optional)")
    p.add_argument("--small-cost", type=int, default=DEFAULT_SMALL_COST,
                   help="Marks per budded Small (default 10; use 0 to treat Smalls as free-farmed)")
    p.add_argument("--fewest-clicks", action="store_true",
                   help="batch budding into triple/double buds (same Marks, fewer actions)")
    p.add_argument("--demo", action="store_true", help="run the built-in examples and exit")
    args = p.parse_args()

    if args.demo or not args.target:
        if not args.target and not args.demo:
            print("No --target given; showing the built-in demo. "
                  "Run with -h to see how to pass your own.\n")
        _demo()
        return

    target = make(**_parse_kv(args.target))
    inventory = make(**_parse_kv(args.have))
    plan = solve(target, inventory, small_cost=args.small_cost)
    plan.bud_mode = "fewest" if args.fewest_clicks else "mono"
    print(plan)
    rows = [(c, plan.small_gems[c], plan.buds[c])
            for c in COLORS if plan.small_gems[c]]
    if rows:
        print("Small gems (total used = owned + to get):")
        for c, total, to_get in rows:
            owned = total - to_get
            print(f"    {c:9s} {total:4d} used   ({owned} owned, {to_get} to bud/farm)")


# --- built-in examples / self-test ---------------------------------------
def _demo():
    print("=== scratch unit costs (Marks, any color) ===")
    for t in range(4):
        print(f"  {TIERS[t]:9s}: {scratch_unit_cost(t)}")

    print("\n=== Example 1: mixed target, empty inventory ===")
    tgt1 = make(sapphire_flawless=2, ruby_flawless=1, emerald_splendid=4, topaz_large=3)
    p1 = solve(tgt1)
    print(p1)
    print("  small gems to acquire:",
          {c: n for c, n in p1.small_gems.items() if n})

    print("\n  same target, Smalls treated as free-farmed (small_cost=0):")
    p1b = solve(tgt1, small_cost=0)
    print("   ", p1b.breakdown(), "-> total", p1b.total_marks,
          "| smalls to farm:", {c: n for c, n in p1b.small_gems.items() if n})

    print("\n=== Example 2: salvage a wrong-color Flawless ===")
    tgt2 = make(sapphire_flawless=1)
    inv2 = make(ruby_flawless=1)
    print(solve(tgt2, inv2))

    print("\n=== Example 3: fuse 3 wrong-color Splendids up into the target ===")
    tgt3 = make(sapphire_flawless=1)
    inv3 = make(emerald_splendid=3)
    print(solve(tgt3, inv3))

    print("\n=== Example 4: transmute across at same tier ===")
    tgt4 = make(sapphire_splendid=3)
    inv4 = make(emerald_splendid=3)
    print(solve(tgt4, inv4))

    print("\n=== Example 5: big build, partial inventory ===")
    tgt5 = make(sapphire_flawless=4, amethyst_flawless=2)
    inv5 = make(sapphire_splendid=5, ruby_flawless=1, diamond_flawless=1, sapphire_small=10)
    print(solve(tgt5, inv5))


if __name__ == "__main__":
    _cli()

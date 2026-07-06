"""
Parity oracle. Reads a JSON array of cases on stdin, emits a JSON array of
results (same shape as solver.js planToDict) on stdout. Used by parity.mjs to
check the JS port against the tested Python engine.

Each case: {"target": {...}, "have": {...}, "small_cost": 10, "fewest_clicks": false}
"""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gem_solver import make, solve, COLORS, TIERS


def plan_to_dict(plan):
    smalls = []
    for c in COLORS:
        total = plan.small_gems.get(c, 0)
        if total:
            to_get = plan.buds.get(c, 0)
            smalls.append({"color": c, "total": total,
                           "owned": total - to_get, "to_get": to_get})
    leftover = [{"color": c, "tier": TIERS[t], "n": n}
                for (c, t), n in plan.leftover.items() if n]
    steps = []
    for s in plan.ordered_steps():
        s = dict(s)
        if "tier" in s:
            s["tier_name"] = TIERS[s["tier"]]
            if s["kind"] == "fuse":
                s["to_name"] = TIERS[s["tier"] + 1]
        steps.append(s)
    return {
        "total_marks": plan.total_marks,
        "breakdown": plan.breakdown(),
        "resources": plan.resources(),
        "steps": steps,
        "smalls": smalls,
        "leftover": leftover,
    }


def main():
    cases = json.load(sys.stdin)
    out = []
    for case in cases:
        target = make(**case.get("target", {}))
        have = make(**case.get("have", {}))
        small_cost = int(case.get("small_cost", 10))
        plan = solve(target, have, small_cost=small_cost)
        plan.bud_mode = "fewest" if case.get("fewest_clicks") else "mono"
        out.append(plan_to_dict(plan))
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()

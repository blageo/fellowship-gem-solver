# Fellowship Tools — static web apps

Minimum-cost planners for **Fellowship** (Early Access Season 3). `index.html` is a
landing page that links to each tool:

- **Gem Fusion Solver** (`gem.html`) — enter the gems you want and the gems you own;
  it returns the cheapest plan (exact vendor shopping list, ordered
  do-this-then-that plan, Small gems to bud or farm).
- **Gear Upgrade Planner** (`gear.html`) — describe a gear item's current and target
  rarity/modifiers/stats; it returns the expected Souldust/Marks cost to get there.

**Everything runs entirely in your browser.** The gem solver's MILP is solved
client-side by [HiGHS](https://highs.dev) compiled to WebAssembly
([highs-js](https://github.com/lovasoa/highs-js)); the gear planner is plain
arithmetic, no solver needed. No backend, no network calls after the page and its
assets load.

## Run locally

Any static file server works — ES modules and the `.wasm` need an `http://` origin
(not `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000 and pick a tool
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | landing page linking to `gem.html` and `gear.html` |
| `style.css` | shared dark theme for both tools |
| `gem.html` / `app.js` | gem solver page + browser glue: grids, URL state, loads highs-js, renders the plan |
| `solver.js` | environment-agnostic core: MILP model (LP string), solve, plan derivations |
| `game-constants.js` | gem system constants (costs, colours, patch version) — edit here when the game patches |
| `vendor/highs.js`, `vendor/highs.wasm` | HiGHS solver (WebAssembly), self-contained |
| `gem_solver.py` | the original Python engine — kept as the **parity oracle**, not shipped to users |
| `tools/parity.mjs`, `tools/oracle.py` | parity harness: JS port vs Python oracle |
| `gear.html` / `gear-app.js` | gear planner page + browser glue: per-slot forms, calculate, saved builds |
| `gear-constants.js` | gear system constants (slots, rarities, modifier pools, souldust costs) |
| `gear-model.js` | validated data model: `GearItem`, `WeaponTraitTree`, `NeckAttunements`, `GearBuild` |
| `gear-upgrade-cost.js` | pure calculator: current + target `GearItem` → expected `UpgradeCost` |
| `gear-builds-store.js` | localStorage persistence for named `GearBuild`s |
| `tools/gear_test.mjs` | regression checks for the gear upgrade cost calculator (`npm run gear-test`) |

## Shareable builds

The current target, inventory and toggles are encoded in the URL query string, e.g.

```
?t=sapphire_flawless:2,ruby_flawless:1&i=sapphire_splendid:5&free=0&fewest=1
```

Opening such a link hydrates the grids and auto-solves. The **🔗 Copy shareable
link** control under the results copies the current build's URL.

## Correctness / parity

`solver.js` and `gem_solver.py` both formulate the *same* MILP and solve it with the
*same* engine (HiGHS — scipy.optimize.milp wraps it too), so results match exactly.
A small lexicographic tie-breaker on the transmute variables (identical in both)
makes the chosen plan deterministic — the two agree on the full shopping list, not
just the total. Run the harness (needs Python with numpy/scipy, and Node):

```sh
PYTHON=/path/to/python-with-scipy node tools/parity.mjs --n 500 --seed 12345
```

It generates random `(target, inventory, small_cost∈{0,10}, bud_mode∈{mono,fewest})`
cases and asserts exact parity of `total_marks`, the full vendor shopping list, the
farm/seed lists, and the per-color Smalls. It also checks `resources.marks ==
total_marks` for every case.

## Deploy (free static hosting)

Publish the site root as-is. The `.wasm` must be served as `application/wasm`
(GitHub Pages, Cloudflare Pages and Netlify all do this by default).

- **GitHub Pages** — push the repo, enable Pages (Settings → Pages → deploy from
  branch, root). Node modules and `tools/` don't need to be published, but they do
  no harm. If you serve from a project subpath, all asset paths here are relative,
  so it works unchanged.
- **Cloudflare Pages / Netlify** — new project → connect the repo → no build command,
  output directory = repo root (`/`).

Nothing needs a build step; the shipped app is `index.html`, `gem.html`, `gear.html`,
`style.css`, `app.js`, `gear-app.js`, `solver.js`, the `gear-*.js` modules, and
`vendor/`.

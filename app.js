// Browser glue for the Fellowship gem solver. All maths lives in solver.js; this
// file builds the grids, loads highs-js, solves locally (no backend), renders the
// plan, and keeps a shareable build in the URL.
import { COLORS, TIERS, GEM_HEX, makeGrid, solve, planToDict } from "./solver.js";
import { SEASON, PATCH } from "./game-constants.js";

const HEX = GEM_HEX;
let highs = null;

// --- load highs-js (vendored, self-contained) -----------------------------
// vendor/highs.js is a classic UMD script that defines a global `Module` factory;
// load it as a classic <script>, then instantiate pointing locateFile at the wasm.
function loadHighs() {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/highs.js";
    s.onload = () => {
      window.Module({ locateFile: (f) => "vendor/" + f }).then(resolve, reject);
    };
    s.onerror = () => reject(new Error("failed to load vendor/highs.js"));
    document.head.appendChild(s);
  });
}

// --- grids ----------------------------------------------------------------
function buildGrid(which) {
  let h = "<table><tr><th></th>";
  for (const t of TIERS) h += `<th class="col">${t}</th>`;
  h += "</tr>";
  for (const c of COLORS) {
    h += `<tr><td class="rowlab" data-color="${c}"><span class="dot" style="background:${HEX[c]}"></span>${c}</td>`;
    for (const t of TIERS) {
      h += `<td><input type="number" min="0" step="1" id="${which}_${c}_${t}" placeholder="0"></td>`;
    }
    h += "</tr>";
  }
  h += "</table>";
  document.getElementById("grid-" + which).innerHTML = h;
}

function gather(which) {
  const d = {};
  for (const c of COLORS) for (const t of TIERS) {
    const v = parseInt(document.getElementById(`${which}_${c}_${t}`).value, 10);
    if (v > 0) d[`${c}_${t}`] = v;
  }
  return d;
}

function setInputs(which, entries) {
  for (const c of COLORS) for (const t of TIERS) {
    const el = document.getElementById(`${which}_${c}_${t}`);
    const key = `${c}_${t}`;
    el.value = entries[key] ? String(entries[key]) : "";
  }
}

// --- named build slots (localStorage) ------------------------------------
const BUILDS_KEY = "fellowship-gem-solver:builds";

function loadBuilds() {
  try { return JSON.parse(localStorage.getItem(BUILDS_KEY)) || []; }
  catch { return []; }
}

function saveBuilds(builds) {
  localStorage.setItem(BUILDS_KEY, JSON.stringify(builds));
}

function refreshBuildSelect() {
  const sel = document.getElementById("savedBuilds");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— saved builds —</option>';
  for (const b of loadBuilds()) {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

function saveBuild() {
  const name = document.getElementById("buildName").value.trim();
  if (!name) return;
  const builds = loadBuilds().filter((b) => b.name !== name);
  builds.unshift({
    name,
    target: gather("target"),
    have: gather("have"),
    free: document.getElementById("freeSmalls").checked,
    fewest: document.getElementById("fewestClicks").checked,
  });
  saveBuilds(builds.slice(0, 20)); // cap at 20
  refreshBuildSelect();
  document.getElementById("savedBuilds").value = name;
}

function loadBuild() {
  const name = document.getElementById("savedBuilds").value;
  if (!name) return;
  const build = loadBuilds().find((b) => b.name === name);
  if (!build) return;
  setInputs("target", build.target);
  setInputs("have", build.have);
  document.getElementById("freeSmalls").checked = build.free || false;
  document.getElementById("fewestClicks").checked = build.fewest || false;
  document.getElementById("buildName").value = name;
}

function deleteBuild() {
  const name = document.getElementById("savedBuilds").value;
  if (!name) return;
  saveBuilds(loadBuilds().filter((b) => b.name !== name));
  document.getElementById("buildName").value = "";
  refreshBuildSelect();
}

// --- collapsible colour rows ----------------------------------------------
// Clicking a colour label collapses/expands its tier cells. On narrow screens
// rows start collapsed so the full 6×4 grid is not shown all at once.
function addRowToggles(which) {
  const narrow = window.matchMedia("(max-width: 620px)").matches;
  for (const c of COLORS) {
    const label = document.querySelector(`#grid-${which} td[data-color="${c}"]`);
    if (!label) continue;
    const row = label.closest("tr");
    if (narrow) row.classList.add("collapsed");
    label.addEventListener("click", () => row.classList.toggle("collapsed"));
  }
}

// --- swipe-to-increment on touch devices ----------------------------------
// Swipe up on a number input increments its value; swipe down decrements.
// Prevents page scroll while a vertical swipe is in progress on an input.
function addSwipeIncrement() {
  document.querySelectorAll("input[type=number]").forEach((el) => {
    let startY = null;
    el.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (startY !== null && Math.abs(startY - e.touches[0].clientY) > 8) e.preventDefault();
    }, { passive: false });
    el.addEventListener("touchend", (e) => {
      if (startY === null) return;
      const dy = startY - e.changedTouches[0].clientY;
      startY = null;
      if (Math.abs(dy) < 15) return;
      el.value = Math.max(0, (parseInt(el.value, 10) || 0) + (dy > 0 ? 1 : -1));
    });
  });
}

// --- keyboard navigation --------------------------------------------------
// Arrow keys move focus between grid cells within the same panel (target or have).
// Left/Right crosses tiers; Up/Down crosses colours. Tab/Enter keep default behaviour.
function addKeyboardNav(which) {
  for (let ci = 0; ci < COLORS.length; ci++) {
    for (let ti = 0; ti < TIERS.length; ti++) {
      const el = document.getElementById(`${which}_${COLORS[ci]}_${TIERS[ti]}`);
      el.addEventListener("keydown", (e) => {
        let nc = ci, nt = ti;
        if (e.key === "ArrowRight")      nt = Math.min(ti + 1, TIERS.length - 1);
        else if (e.key === "ArrowLeft")  nt = Math.max(ti - 1, 0);
        else if (e.key === "ArrowDown")  nc = Math.min(ci + 1, COLORS.length - 1);
        else if (e.key === "ArrowUp")    nc = Math.max(ci - 1, 0);
        else return;
        e.preventDefault();
        document.getElementById(`${which}_${COLORS[nc]}_${TIERS[nt]}`).focus();
      });
    }
  }
}

function clearAll() {
  document.querySelectorAll("input[type=number]").forEach((i) => (i.value = ""));
  document.getElementById("freeSmalls").checked = false;
  document.getElementById("fewestClicks").checked = false;
  document.getElementById("out").innerHTML = "";
  history.replaceState(null, "", location.pathname);
}

// --- URL state (shareable builds) -----------------------------------------
// ?t=sapphire_flawless:2,ruby_flawless:1&i=sapphire_splendid:5&free=1&fewest=1
function encodeEntries(d) {
  return Object.entries(d).map(([k, v]) => `${k}:${v}`).join(",");
}
function decodeEntries(str) {
  const d = {};
  if (!str) return d;
  for (const tok of str.split(",")) {
    const [k, v] = tok.split(":");
    const n = parseInt(v, 10);
    if (k && n > 0) d[k] = n;
  }
  return d;
}
function currentQuery() {
  const p = new URLSearchParams();
  const t = gather("target");
  const i = gather("have");
  if (Object.keys(t).length) p.set("t", encodeEntries(t));
  if (Object.keys(i).length) p.set("i", encodeEntries(i));
  if (document.getElementById("freeSmalls").checked) p.set("free", "1");
  if (document.getElementById("fewestClicks").checked) p.set("fewest", "1");
  return p.toString();
}
function hydrateFromURL() {
  const p = new URLSearchParams(location.search);
  const t = decodeEntries(p.get("t"));
  const i = decodeEntries(p.get("i"));
  setInputs("target", t);
  setInputs("have", i);
  document.getElementById("freeSmalls").checked = p.get("free") === "1";
  document.getElementById("fewestClicks").checked = p.get("fewest") === "1";
  return Object.keys(t).length > 0;
}

// --- solve + render -------------------------------------------------------
function calc() {
  const out = document.getElementById("out");
  const target = gather("target");
  const have = gather("have");
  if (Object.keys(target).length === 0) {
    out.innerHTML = '<p class="err">Enter at least one target gem.</p>';
    return;
  }
  const smallCost = document.getElementById("freeSmalls").checked ? 0 : 10;
  const budMode = document.getElementById("fewestClicks").checked ? "fewest" : "mono";
  try {
    const plan = solve(highs, makeGrid(target), makeGrid(have), smallCost);
    plan.bud_mode = budMode;
    render(planToDict(plan));
    history.replaceState(null, "", location.pathname + "?" + currentQuery());
  } catch (e) {
    out.innerHTML = `<p class="err">${e}</p>`;
  }
}

function render(p) {
  const b = p.breakdown;
  let h = `<div class="total">${p.total_marks} Marks</div>`;
  h += `<div class="bd">budding ${b.budding} &nbsp;·&nbsp; fusion aether ${b.fusion_aether} &nbsp;·&nbsp; transmutation ${b.transmutation}</div>`;

  const r = p.resources;
  h += '<div class="card buy"><h3>Buy at vendor</h3><table class="small-tbl">';
  const note = (d, keys) => keys.filter((k) => d[k]).map((k) => `${d[k]} ${k}`).join(" + ") || "fuse";
  const aetherRow = (name, d, keys) => d.total
    ? `<tr><td><b>${name}</b></td><td class="qty">×${d.total}</td><td class="muted">${note(d, keys)}</td></tr>` : "";
  h += aetherRow("Unstable Aether", r.unstable, ["fuse", "bud"]);
  h += aetherRow("Imbued Aether", r.imbued, ["fuse", "bud"]);
  h += aetherRow("Arcane Aether", r.arcane, ["fuse", "transmute", "bud"]);
  const g = r.godstones || {};
  const gsRow = (name, n, use) => n
    ? `<tr><td><b>${name}</b></td><td class="qty">×${n}</td><td class="muted">${use}</td></tr>` : "";
  h += gsRow("Defender's Godstone", g.defender, "monobud");
  h += gsRow("Hero's Godstone", g.hero, "double bud");
  h += gsRow("Legend's Godstone", g.legend, "triple bud");
  h += `<tr><td class="muted" style="padding-top:8px">= Marks of Fellowship</td><td class="qty" style="padding-top:8px"><b>${r.marks}</b></td><td></td></tr>`;
  h += "</table>";
  if (r.farm_smalls && Object.keys(r.farm_smalls).length) {
    h += '<div class="line" style="margin-top:8px">Farm Small gems: '
       + Object.entries(r.farm_smalls).map(([c, n]) => `${n} ${c}`).join(", ") + "</div>";
  }
  if (r.seed_smalls && r.seed_smalls.length) {
    h += '<div class="line muted" style="margin-top:4px">Seed Smalls needed (1 each to start budding): '
       + r.seed_smalls.join(", ") + "</div>";
  }
  h += '<div class="sharebar" style="margin-top:10px"><a id="copyListLink">📋 Copy shopping list</a><span id="listCopied"></span></div>';
  h += "</div>";

  if (p.smalls.length) {
    h += '<div class="card shop"><h3>Shopping list — Small gems to bud / farm</h3>';
    h += '<table class="small-tbl">';
    for (const s of p.smalls) {
      h += `<tr><td><span class="dot" style="background:${HEX[s.color]}"></span>${s.color}</td>`;
      h += `<td><b>${s.to_get}</b> to get</td><td class="muted">(${s.owned} owned, ${s.total} used total)</td></tr>`;
    }
    h += "</table></div>";
  }

  if (p.steps && p.steps.length) {
    h += '<div class="card"><h3>Plan — do these in order</h3>';
    let i = 0;
    for (const s of p.steps) {
      i++;
      if (s.kind === "bud" || s.kind === "farm") {
        const verb = s.kind === "bud" ? "Bud Smalls" : "Farm Smalls";
        h += `<div class="step"><span class="num">${i}</span><b>${verb}</b>`;
        for (const it of s.items) {
          let act = "";
          if (s.kind === "bud") {
            const a = it.actions, parts = [];
            if (a.triple) parts.push(`${a.triple}× triple`);
            if (a.double) parts.push(`${a.double}× double`);
            if (a.mono) parts.push(`${a.mono}× mono`);
            act = ` <span class="muted">(${parts.join(", ")})</span>`;
          }
          h += `<div class="line"><span class="dot" style="background:${HEX[it.color]}"></span>+${it.n} ${it.color}${act}</div>`;
        }
        h += "</div>";
      } else if (s.kind === "fuse") {
        h += `<div class="step"><span class="num">${i}</span><b>Fuse ${s.tier_name} → ${s.to_name}</b>`;
        for (const it of s.items)
          h += `<div class="line"><span class="dot" style="background:${HEX[it.color]}"></span>${it.n}× &nbsp;3 ${it.color} ${s.tier_name} → 1 ${it.color} ${s.to_name}</div>`;
        h += "</div>";
      } else if (s.kind === "transmute") {
        h += `<div class="step"><span class="num">${i}</span><b>Transmute ${s.tier_name} <span class="muted">(Arcane)</span></b>`;
        for (const it of s.items)
          h += `<div class="line"><span class="dot" style="background:${HEX[it.from]}"></span>${it.n}× &nbsp;${it.from} → <span class="dot" style="background:${HEX[it.to]}"></span>${it.to}</div>`;
        h += "</div>";
      }
    }
    h += "</div>";
  }

  if (p.leftover.length) {
    h += '<div class="card"><h3>Leftover</h3>';
    h += '<div class="line muted">' + p.leftover.map((l) => `${l.n} ${l.color} ${l.tier}`).join(", ") + "</div></div>";
  }

  h += '<div class="sharebar"><a id="shareLink">🔗 Copy shareable link</a><span id="copied"></span></div>';

  document.getElementById("out").innerHTML = h;
  document.getElementById("shareLink").addEventListener("click", copyShareLink);
  document.getElementById("copyListLink").addEventListener("click", () => copyShoppingList(p));
}

function buildShoppingListText(p) {
  const r = p.resources;
  const lines = [`Fellowship Gem Plan — ${p.total_marks} Marks`, ""];
  lines.push("Buy at vendor:");
  const add = (name, n) => { if (n) lines.push(`  ${name} ×${n}`); };
  add("Unstable Aether", r.unstable.total);
  add("Imbued Aether", r.imbued.total);
  add("Arcane Aether", r.arcane.total);
  add("Defender's Godstone", r.godstones.defender);
  add("Hero's Godstone", r.godstones.hero);
  add("Legend's Godstone", r.godstones.legend);
  lines.push(`  = ${r.marks} Marks of Fellowship`);
  if (p.smalls.length) {
    lines.push("");
    lines.push("Small gems to bud/farm:");
    for (const s of p.smalls) lines.push(`  ${s.color}: ${s.to_get} to get (${s.owned} owned)`);
  }
  if (Object.keys(r.farm_smalls || {}).length) {
    lines.push("");
    lines.push("Farm smalls: " + Object.entries(r.farm_smalls).map(([c, n]) => `${n} ${c}`).join(", "));
  }
  return lines.join("\n");
}

async function copyShoppingList(p) {
  const text = buildShoppingListText(p);
  const note = document.getElementById("listCopied");
  try {
    await navigator.clipboard.writeText(text);
    note.textContent = "copied!";
    note.className = "copied";
  } catch {
    note.textContent = "(copy failed)";
    note.className = "muted";
  }
  setTimeout(() => { note.textContent = ""; }, 2500);
}

async function copyShareLink() {
  const url = location.origin + location.pathname + "?" + currentQuery();
  const note = document.getElementById("copied");
  try {
    await navigator.clipboard.writeText(url);
    note.textContent = "copied!";
    note.className = "copied";
  } catch {
    note.textContent = url;
    note.className = "muted";
  }
  setTimeout(() => { note.textContent = ""; }, 2500);
}

// --- boot -----------------------------------------------------------------
buildGrid("target");
buildGrid("have");
addKeyboardNav("target");
addKeyboardNav("have");
addRowToggles("target");
addRowToggles("have");
addSwipeIncrement();
refreshBuildSelect();
document.getElementById("saveBuildBtn").addEventListener("click", saveBuild);
document.getElementById("loadBuildBtn").addEventListener("click", loadBuild);
document.getElementById("deleteBuildBtn").addEventListener("click", deleteBuild);
document.getElementById("version").textContent = `${SEASON} · patch ${PATCH}`;
document.getElementById("clearBtn").addEventListener("click", clearAll);
const hasTarget = hydrateFromURL();

loadHighs().then((h) => {
  highs = h;
  const btn = document.getElementById("calcBtn");
  btn.disabled = false;
  btn.textContent = "Calculate";
  btn.addEventListener("click", calc);
  if (hasTarget) calc(); // auto-solve a shared build
}).catch((e) => {
  document.getElementById("out").innerHTML = `<p class="err">Could not load solver: ${e}</p>`;
});

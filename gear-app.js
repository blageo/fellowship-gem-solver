// Browser glue for the gear upgrade planner. All maths lives in
// gear-upgrade-cost.js / gear-model.js; this file builds the per-slot forms,
// gathers input, calls the calculator, and renders the result. No solver here
// — this is pure arithmetic, so there's no HiGHS/WASM dependency.
import {
  SEASON, PATCH, ITEM_SLOTS, ITEM_TYPES, RARITIES, LEAGUES,
  RANDOM_STAT_TYPES, MODIFIER_CATEGORIES, RARITY_UNLOCKS,
} from "./gear-constants.js";
import { makeGearItem, makeTargetGearItem } from "./gear-model.js";
import { computeUpgradeCost } from "./gear-upgrade-cost.js";
import { loadGearBuilds, upsertGearBuild, deleteGearBuild } from "./gear-builds-store.js";

const MODIFIER_CATEGORY_NAMES = Object.keys(MODIFIER_CATEGORIES);
const LOCKED_CATEGORY_FOR_ITEM_TYPE = { set: "setBonus", weapon: "weaponAbility", relic: "relicAbility" };
const MAX_MODIFIER_SLOTS = 3;
const GEM_BUILDS_KEY = "fellowship-gem-solver:builds"; // read-only peek, owned by app.js

function defaultCurrent() {
  return { itemType: "normal", setName: "", rarity: "green", league: "contender", randomStats: [], modifierSlots: [] };
}
function defaultTarget() {
  return { minRarity: "", randomStats: [], modifierSlots: [] };
}

let buildState = { name: "", gemBuildId: "", slots: {} };
for (const slot of ITEM_SLOTS) buildState.slots[slot] = { current: defaultCurrent(), target: defaultTarget() };
let activeSlot = ITEM_SLOTS[0];

// --- static selects ---------------------------------------------------
function fillSelect(id, values, { blankLabel } = {}) {
  const sel = document.getElementById(id);
  sel.innerHTML = "";
  if (blankLabel !== undefined) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = blankLabel;
    sel.appendChild(opt);
  }
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
}

function populateStaticSelects() {
  fillSelect("slotSelect", ITEM_SLOTS);
  fillSelect("itemType", ITEM_TYPES);
  fillSelect("cur_rarity", RARITIES);
  fillSelect("cur_league", LEAGUES);
  fillSelect("tgt_minRarity", RARITIES, { blankLabel: "— no requirement —" });
}

// --- random stat checkboxes --------------------------------------------
function renderStatCheckboxes(containerId, prefix) {
  const box = document.getElementById(containerId);
  box.innerHTML = "";
  for (const stat of RANDOM_STAT_TYPES) {
    const label = document.createElement("label");
    label.className = "opt";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `${prefix}_stat_${stat}`;
    input.dataset.stat = stat;
    label.appendChild(input);
    label.append(" " + stat);
    box.appendChild(label);
  }
}

// --- modifier slot rows --------------------------------------------------
function renderModifierRows(containerId, prefix) {
  const box = document.getElementById(containerId);
  box.innerHTML = "";
  for (let i = 0; i < MAX_MODIFIER_SLOTS; i++) {
    const row = document.createElement("div");
    row.className = "modslot-row";

    const catSelect = document.createElement("select");
    catSelect.id = `${prefix}_modcat_${i}`;
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = prefix === "cur" ? "— empty —" : "— no requirement —";
    catSelect.appendChild(noneOpt);
    for (const cat of MODIFIER_CATEGORY_NAMES) {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      catSelect.appendChild(opt);
    }

    const idInput = document.createElement("input");
    idInput.type = "text";
    idInput.id = `${prefix}_modid_${i}`;
    idInput.placeholder = "modifier id (optional)";
    idInput.maxLength = 60;

    row.append(`Slot ${i + 1}: `, catSelect, idInput);
    box.appendChild(row);
  }
}

// --- locks: itemType locks slot 0's category; rarity caps slot/stat count ---
// Row/field locking depends on two independent inputs (itemType, rarity), so
// it's recomputed from scratch from both every time either changes — never
// combined with whatever a previous, possibly-stale .disabled value was.
function applyLocks() {
  const itemType = document.getElementById("itemType").value;
  const rarity = document.getElementById("cur_rarity").value;
  document.getElementById("setNameWrap").style.display = itemType === "set" ? "" : "none";
  const lockedCategory = LOCKED_CATEGORY_FOR_ITEM_TYPE[itemType];
  const unlock = RARITY_UNLOCKS[rarity];

  for (let i = 0; i < MAX_MODIFIER_SLOTS; i++) {
    const beyondRarity = i >= unlock.modifierSlots;
    const cat = document.getElementById(`cur_modcat_${i}`);
    const idEl = document.getElementById(`cur_modid_${i}`);
    const row = cat.closest(".modslot-row");
    row.classList.toggle("locked", beyondRarity);
    idEl.disabled = beyondRarity;
    if (i === 0 && lockedCategory) cat.value = lockedCategory;
    cat.disabled = beyondRarity || (i === 0 && !!lockedCategory);
  }
  // Random stat *count* is capped by rarity (1 below yellow, 2 at/above), but
  // any of the 6 types can be that roll — there's no positional mapping like
  // modifier slots have, so we don't disable specific checkboxes here.
  // makeGearItem() throws if too many are checked; calc() surfaces that.
}

function updateWeaponNeckNote(slot) {
  const note = document.getElementById("weaponNeckNote");
  if (slot === "weapon") {
    note.textContent = "Weapon trait tree planning isn't in the UI yet (rarity/modifier slots below still apply).";
    note.style.display = "";
  } else if (slot === "neck") {
    note.textContent = "Neck attunement planning isn't in the UI yet (rarity/modifier slots below still apply).";
    note.style.display = "";
  } else {
    note.style.display = "none";
  }
}

// --- gather/populate form <-> buildState ----------------------------------
function gatherModifierRows(prefix) {
  const rows = [];
  for (let i = 0; i < MAX_MODIFIER_SLOTS; i++) {
    const cat = document.getElementById(`${prefix}_modcat_${i}`);
    const idEl = document.getElementById(`${prefix}_modid_${i}`);
    if (cat.disabled || !cat.value) { rows.push(null); continue; }
    rows.push({ category: cat.value, modifierId: idEl.value.trim() || undefined });
  }
  return rows;
}

function setModifierRows(prefix, rows) {
  for (let i = 0; i < MAX_MODIFIER_SLOTS; i++) {
    const cat = document.getElementById(`${prefix}_modcat_${i}`);
    const idEl = document.getElementById(`${prefix}_modid_${i}`);
    const entry = rows[i];
    if (!cat.disabled) cat.value = entry ? entry.category : "";
    idEl.value = entry?.modifierId || "";
  }
}

function gatherStats(prefix) {
  return [...document.querySelectorAll(`#${prefix}_randomStats input[type=checkbox]`)]
    .filter((b) => b.checked && !b.disabled)
    .map((b) => b.dataset.stat);
}

function setStats(prefix, stats) {
  document.querySelectorAll(`#${prefix}_randomStats input[type=checkbox]`).forEach((b) => {
    b.checked = !b.disabled && stats.includes(b.dataset.stat);
  });
}

function stashActiveSlotForm() {
  const slotData = buildState.slots[activeSlot];
  slotData.current = {
    itemType: document.getElementById("itemType").value,
    setName: document.getElementById("setName").value.trim(),
    rarity: document.getElementById("cur_rarity").value,
    league: document.getElementById("cur_league").value,
    randomStats: gatherStats("cur"),
    modifierSlots: gatherModifierRows("cur"),
  };
  slotData.target = {
    minRarity: document.getElementById("tgt_minRarity").value,
    randomStats: gatherStats("tgt"),
    modifierSlots: gatherModifierRows("tgt"),
  };
}

function loadSlotIntoForm(slot) {
  const { current, target } = buildState.slots[slot];
  document.getElementById("slotSelect").value = slot;
  document.getElementById("itemType").value = current.itemType;
  document.getElementById("setName").value = current.setName;
  document.getElementById("cur_rarity").value = current.rarity;
  document.getElementById("cur_league").value = current.league;
  document.getElementById("tgt_minRarity").value = target.minRarity;

  applyLocks();
  setStats("cur", current.randomStats);
  setModifierRows("cur", current.modifierSlots);
  setStats("tgt", target.randomStats);
  setModifierRows("tgt", target.modifierSlots);
  updateWeaponNeckNote(slot);
}

// --- current-slot raw data -> validated model objects ---------------------
function toGearItem(slot, current) {
  return makeGearItem({
    id: slot,
    name: slot,
    slot,
    itemType: current.itemType,
    setName: current.itemType === "set" ? (current.setName || "Unnamed Set") : undefined,
    rarity: current.rarity,
    league: current.league,
    randomStats: current.randomStats.map((stat) => ({ stat })),
    modifierSlots: current.modifierSlots.filter(Boolean),
  });
}

function toTargetGearItem(target) {
  return makeTargetGearItem({
    minRarity: target.minRarity || undefined,
    randomStats: target.randomStats,
    modifierSlots: target.modifierSlots.filter(Boolean),
  });
}

// --- rendering --------------------------------------------------------
function renderCost(cost, title) {
  const legendaryWarn = cost.legendarySouldust > 0
    ? `<p class="legendary-warn">${fmt(cost.legendarySouldust)} Legendary Souldust expected — scarce, minimise this first.</p>`
    : "";
  const notes = cost.notes.length
    ? `<ul class="notes">${cost.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`
    : "";
  return `
    <div class="card">
      <h3>${escapeHtml(title)}</h3>
      <div class="total">${fmt(cost.totalMarks)} Marks</div>
      <div class="bd">
        Epic Souldust: ${fmt(cost.epicSouldust)} Marks &middot;
        5 Mark rerolls: ${fmt(cost.rerolls5Mark)} (expected) &middot;
        10 Mark rerolls: ${fmt(cost.rerolls10Mark)}
      </div>
      ${legendaryWarn}
      ${notes}
    </div>`;
}

function renderBuildTotal(totalMarks, totalLegendary, configuredSlots) {
  const legendaryWarn = totalLegendary > 0
    ? `<p class="legendary-warn">${fmt(totalLegendary)} Legendary Souldust expected across the build — scarce, minimise this first.</p>`
    : "";
  return `
    <div class="card">
      <h3>Build total (${configuredSlots} slots configured)</h3>
      <div class="total">${fmt(totalMarks)} Marks</div>
      ${legendaryWarn}
    </div>`;
}

function fmt(n) {
  return Math.round(n * 100) / 100;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function calc() {
  stashActiveSlotForm();
  const out = document.getElementById("out");
  let html = "";

  try {
    const slotData = buildState.slots[activeSlot];
    const current = toGearItem(activeSlot, slotData.current);
    const target = toTargetGearItem(slotData.target);
    const cost = computeUpgradeCost(current, target);
    html += renderCost(cost, `${activeSlot} — this slot`);
  } catch (e) {
    out.innerHTML = `<p class="err">${escapeHtml(e.message)}</p>`;
    return;
  }

  // Build total: every slot with at least one target requirement set.
  let totalMarks = 0;
  let totalLegendary = 0;
  let configuredSlots = 0;
  for (const slot of ITEM_SLOTS) {
    const { current, target } = buildState.slots[slot];
    const hasTarget = target.minRarity || target.randomStats.length || target.modifierSlots.some(Boolean);
    if (!hasTarget) continue;
    try {
      const cost = computeUpgradeCost(toGearItem(slot, current), toTargetGearItem(target));
      totalMarks += cost.totalMarks;
      totalLegendary += cost.legendarySouldust;
      configuredSlots++;
    } catch {
      // Skip slots that aren't valid yet (e.g. mid-edit); this slot's own
      // Calculate above already surfaces its error if it's the active one.
    }
  }
  if (configuredSlots > 1) {
    html += renderBuildTotal(totalMarks, totalLegendary, configuredSlots);
  }

  out.innerHTML = html;
}

function clearSlot() {
  buildState.slots[activeSlot] = { current: defaultCurrent(), target: defaultTarget() };
  loadSlotIntoForm(activeSlot);
  document.getElementById("out").innerHTML = "";
}

// --- named build slots (localStorage) -------------------------------------
function refreshBuildSelect() {
  const sel = document.getElementById("savedBuilds");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— saved builds —</option>';
  for (const b of loadGearBuilds()) {
    const opt = document.createElement("option");
    opt.value = b.name;
    opt.textContent = b.name;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

function refreshGemBuildLinkSelect() {
  const sel = document.getElementById("gemBuildLink");
  const prev = sel.value;
  sel.innerHTML = '<option value="">— none —</option>';
  let gemBuilds = [];
  try { gemBuilds = JSON.parse(localStorage.getItem(GEM_BUILDS_KEY)) || []; } catch { /* ignore */ }
  for (const b of gemBuilds) {
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
  stashActiveSlotForm();
  buildState.name = name;
  buildState.gemBuildId = document.getElementById("gemBuildLink").value || undefined;
  upsertGearBuild({ ...buildState, name });
  refreshBuildSelect();
  document.getElementById("savedBuilds").value = name;
}

function loadBuild() {
  const name = document.getElementById("savedBuilds").value;
  if (!name) return;
  const build = loadGearBuilds().find((b) => b.name === name);
  if (!build) return;
  buildState = { name: build.name, gemBuildId: build.gemBuildId, slots: {} };
  for (const slot of ITEM_SLOTS) {
    buildState.slots[slot] = build.slots[slot]
      ? { current: { ...defaultCurrent(), ...build.slots[slot].current }, target: { ...defaultTarget(), ...build.slots[slot].target } }
      : { current: defaultCurrent(), target: defaultTarget() };
  }
  document.getElementById("buildName").value = name;
  document.getElementById("gemBuildLink").value = build.gemBuildId || "";
  loadSlotIntoForm(activeSlot);
}

function deleteBuild() {
  const name = document.getElementById("savedBuilds").value;
  if (!name) return;
  deleteGearBuild(name);
  document.getElementById("buildName").value = "";
  refreshBuildSelect();
}

// --- boot -----------------------------------------------------------------
populateStaticSelects();
renderStatCheckboxes("cur_randomStats", "cur");
renderStatCheckboxes("tgt_randomStats", "tgt");
renderModifierRows("cur_modifierSlots", "cur");
renderModifierRows("tgt_modifierSlots", "tgt");
loadSlotIntoForm(activeSlot);
refreshBuildSelect();
refreshGemBuildLinkSelect();

document.getElementById("slotSelect").addEventListener("change", (e) => {
  stashActiveSlotForm();
  activeSlot = e.target.value;
  loadSlotIntoForm(activeSlot);
});
document.getElementById("itemType").addEventListener("change", applyLocks);
document.getElementById("cur_rarity").addEventListener("change", applyLocks);
document.getElementById("calcBtn").addEventListener("click", calc);
document.getElementById("clearBtn").addEventListener("click", clearSlot);
document.getElementById("saveBuildBtn").addEventListener("click", saveBuild);
document.getElementById("loadBuildBtn").addEventListener("click", loadBuild);
document.getElementById("deleteBuildBtn").addEventListener("click", deleteBuild);
document.getElementById("version").textContent = `${SEASON} · patch ${PATCH}`;

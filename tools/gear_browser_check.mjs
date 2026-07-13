// End-to-end browser check for the gear upgrade planner: loads gear.html in a
// real headless Chromium, drives the actual form (category selects,
// dependent modifier-id dropdowns, itemType/rarity locks), and asserts the
// same scenarios the jsdom-based smoke test covered during development —
// same role as tools/browser_check.mjs, but for gear.html.
//
//   node tools/gear_browser_check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8124;
const BASE = `http://127.0.0.1:${PORT}`;
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(BASE + "/gear.html", { waitUntil: "networkidle" });

  // --- same-category, matching pool -> dependent dropdown, 70 Marks ---
  await page.selectOption("#cur_rarity", "blue");
  await page.selectOption("#cur_modcat_0", "majorTrait");
  const modidTag = await page.evaluate(() => document.getElementById("cur_modid_0").tagName);
  if (modidTag !== "SELECT") fail(`expected modid to become a <select>, got ${modidTag}`);
  const traitOptions = await page.$$eval("#cur_modid_0 option", (os) => os.map((o) => o.value));
  if (!traitOptions.includes("Visions of Grandeur")) fail("majorTrait dropdown missing a known trait name");
  if (traitOptions.length !== 10) fail(`expected 10 options (blank + 9 traits), got ${traitOptions.length}`);

  await page.selectOption("#cur_modcat_0", "blessing");
  await page.selectOption("#cur_modid_0", "The Herald");
  await page.selectOption("#tgt_modcat_0", "blessing");
  await page.selectOption("#tgt_modid_0", "The Wayfarer");
  await page.click("#calcBtn");
  const total1 = (await page.textContent("#out .total")).trim();
  console.log("same-category total:", total1, "(expect 70 Marks)");
  if (total1 !== "70 Marks") fail(`same-category total ${total1} != "70 Marks"`);
  const hasLegendaryWarn = await page.$("#out .legendary-warn");
  if (hasLegendaryWarn) fail("unexpected legendary warning for a same-category reroll");

  // --- flooding regression: a blue helm with Martial Initiative in slot 1,
  // upgraded to purple, floods slot 2 with the same trait — wanting that in
  // the target should cost only the rarity upgrade, no Legendary Souldust.
  await page.selectOption("#slotSelect", "shoulders"); // fresh, unconfigured slot
  await page.selectOption("#cur_rarity", "blue");
  await page.check("#cur_stat_haste");
  await page.selectOption("#cur_modcat_0", "majorTrait");
  await page.selectOption("#cur_modid_0", "Martial Initiative");
  await page.selectOption("#tgt_minRarity", "purple");
  await page.selectOption("#tgt_modcat_0", "majorTrait");
  await page.selectOption("#tgt_modid_0", "Martial Initiative");
  await page.selectOption("#tgt_modcat_1", "majorTrait");
  await page.selectOption("#tgt_modid_1", "Martial Initiative");
  await page.click("#calcBtn");
  const floodTotal = (await page.textContent("#out .total")).trim();
  console.log("flooding total:", floodTotal, "(expect 15 Marks)");
  if (floodTotal !== "15 Marks") fail(`flooding total ${floodTotal} != "15 Marks"`);
  if (await page.$("#out .legendary-warn")) fail("flooding a matching trait into slot 2 should not need legendary souldust");

  // --- wrong category -> legendary souldust warning (back on "helm", which
  // still has the blessing/The Herald + blessing/The Wayfarer setup from above) ---
  await page.selectOption("#slotSelect", "helm");
  await page.selectOption("#tgt_modcat_0", "gemEssence");
  await page.click("#calcBtn");
  const warnText = await page.textContent("#out .legendary-warn").catch(() => null);
  console.log("wrong-category legendary warning:", warnText);
  if (!warnText || !warnText.includes("Legendary Souldust")) fail("expected a legendary souldust warning for a wrong-category target");

  // --- itemType lock: set item forces + disables row 0's category ---
  await page.selectOption("#itemType", "set");
  const cat0 = await page.evaluate(() => ({
    value: document.getElementById("cur_modcat_0").value,
    disabled: document.getElementById("cur_modcat_0").disabled,
    modidTag: document.getElementById("cur_modid_0").tagName,
  }));
  console.log("set-item row0:", cat0);
  if (cat0.value !== "setBonus" || !cat0.disabled) fail("set itemType should lock+disable row0 category to setBonus");
  if (cat0.modidTag !== "INPUT") fail("setBonus (no named pool) should keep row0's modifier id as free text");

  // --- switching slots away and back preserves the beyond-rarity lock ---
  await page.selectOption("#itemType", "normal");
  await page.selectOption("#cur_rarity", "blue"); // 1 slot unlocked -> rows 1,2 locked
  await page.selectOption("#slotSelect", "chest");
  await page.selectOption("#slotSelect", "helm");
  const row2Disabled = await page.evaluate(() => document.getElementById("cur_modid_2").disabled);
  if (!row2Disabled) fail("row 2's id field should stay disabled after switching slots away and back");

  // --- save/load round trip ---
  await page.fill("#buildName", "playwright-smoke-build");
  await page.click("#saveBuildBtn");
  const saved = await page.evaluate(() => localStorage.getItem("fellowship-gem-solver:gear-builds"));
  if (!saved || !saved.includes("playwright-smoke-build")) fail("build was not saved to localStorage");

  if (consoleErrors.length) fail("console errors: " + consoleErrors.join(" | "));
  if (pageErrors.length) fail("page errors: " + pageErrors.join(" | "));

  if (!process.exitCode) console.log("\nPASS: gear.html dropdowns, locks, calc, and save/load all work in a real browser.");
} catch (e) {
  fail(String(e));
} finally {
  if (browser) await browser.close();
  server.kill();
}

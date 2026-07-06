// End-to-end browser check (acceptance criterion #5): the static site loads,
// solves client-side, both toggles work, a shared URL hydrates + auto-solves, and
// no network request fires after the initial asset load (i.e. the solve is local).
//
//   node tools/browser_check.mjs
//
// Serves the project root over http (ES modules + .wasm need an http origin),
// drives it with Playwright's headless Chromium, and asserts known totals from the
// Python oracle's Example 1 (1645 Marks; 385 with Smalls free).

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

// --- serve project root ---------------------------------------------------
const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("request", (r) => requests.push(r.url()));

  // shared-build URL for Example 1 -> auto-solves on load
  const share = "?t=sapphire_flawless:2,ruby_flawless:1,emerald_splendid:4,topaz_large:3";
  await page.goto(BASE + "/" + share, { waitUntil: "networkidle" });
  await page.waitForSelector("#out .total", { timeout: 15000 });

  const total1 = (await page.textContent("#out .total")).trim();
  console.log("shared-build total:", total1, "(expect 1645 Marks)");
  if (total1 !== "1645 Marks") fail(`shared build total ${total1} != "1645 Marks"`);

  // check the vendor "Buy at vendor" reconciled marks line is present and equal
  const marksReconcile = await page.textContent("#out .buy");
  if (!marksReconcile.includes("1645")) fail("vendor card marks total != 1645");

  // grids hydrated from URL?
  const sapVal = await page.inputValue("#target_sapphire_flawless");
  if (sapVal !== "2") fail(`grid not hydrated: sapphire_flawless = ${sapVal} (expect 2)`);

  // --- assert solving is local: record a mark, then re-solve, expect 0 requests
  const before = requests.length;
  await page.check("#freeSmalls");        // Smalls free -> total should drop to 385
  await page.click("#calcBtn");
  await page.waitForFunction(() => document.querySelector("#out .total")?.textContent.trim() === "385 Marks", null, { timeout: 10000 })
    .catch(() => {});
  const total2 = (await page.textContent("#out .total")).trim();
  console.log("free-Smalls total:", total2, "(expect 385 Marks)");
  if (total2 !== "385 Marks") fail(`free-Smalls total ${total2} != "385 Marks"`);
  const newRequests = requests.slice(before);
  console.log("network requests during re-solve:", newRequests.length);
  if (newRequests.length !== 0) fail(`solve made ${newRequests.length} network request(s): ${newRequests.join(", ")}`);

  // --- fewest-clicks toggle: total unchanged, but bud actions batch to triple
  await page.uncheck("#freeSmalls");
  await page.check("#fewestClicks");
  await page.click("#calcBtn");
  await page.waitForTimeout(300);
  const total3 = (await page.textContent("#out .total")).trim();
  if (total3 !== "1645 Marks") fail(`fewest-clicks changed total to ${total3} (should stay 1645)`);
  const legend = await page.$("text=Legend's Godstone");
  if (!legend) fail("fewest-clicks did not produce triple buds (no Legend's Godstone row)");
  else console.log("fewest-clicks: batched into triple buds (Legend's Godstone present), total unchanged");

  if (consoleErrors.length) fail("console errors: " + consoleErrors.join(" | "));
  if (pageErrors.length) fail("page errors: " + pageErrors.join(" | "));

  if (!process.exitCode) console.log("\nPASS: loads, solves locally, toggles + shared URL all work, no console errors.");
} catch (e) {
  fail(String(e));
} finally {
  if (browser) await browser.close();
  server.kill();
}

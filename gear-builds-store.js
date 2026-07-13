// localStorage persistence for GearBuild, parallel to app.js's gem build
// slots (BUILDS_KEY = "fellowship-gem-solver:builds"). Kept in its own module
// since no gear UI exists yet to wire buttons up to app.js — once the gear
// planner UI lands, app.js should call these the same way it calls
// loadBuilds()/saveBuilds() for gem builds.

const GEAR_BUILDS_KEY = "fellowship-gem-solver:gear-builds";
const MAX_SAVED = 20;

export function loadGearBuilds() {
  try { return JSON.parse(localStorage.getItem(GEAR_BUILDS_KEY)) || []; }
  catch { return []; }
}

export function saveGearBuilds(builds) {
  localStorage.setItem(GEAR_BUILDS_KEY, JSON.stringify(builds.slice(0, MAX_SAVED)));
}

// Insert/replace by name (name is the user-facing key, same convention as
// gem builds), most-recent first.
export function upsertGearBuild(build) {
  const builds = loadGearBuilds().filter((b) => b.name !== build.name);
  builds.unshift(build);
  saveGearBuilds(builds);
  return builds;
}

export function deleteGearBuild(name) {
  const builds = loadGearBuilds().filter((b) => b.name !== name);
  saveGearBuilds(builds);
  return builds;
}

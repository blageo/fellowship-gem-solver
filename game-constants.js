// Fellowship gem system constants — edit this file when the game updates costs.
// SEASON / PATCH are displayed in the UI footer so players know if values are current.
export const SEASON = "EAS3";
export const PATCH = "0.4.2";

export const COLORS = ["ruby", "amethyst", "topaz", "emerald", "sapphire", "diamond"];
export const TIERS = ["small", "large", "splendid", "flawless"];
export const T = Object.fromEntries(TIERS.map((name, i) => [name, i]));

export const FUSE_COST = { 0: 5, 1: 10, 2: 15 };  // Marks per aether: tier t -> t+1
export const TRANSMUTE_COST = 15;                    // Arcane, guaranteed targeted
export const GODSTONE_COST = { defender: 5, hero: 10, legend: 15 };
export const DEFAULT_SMALL_COST = 10;               // 10 Marks per Small budded

// Tie-breaker weights on transmute variables — keeps JS/Python plans bit-identical.
// See the comment in solver.js for a full explanation.
export const TRANS_TIE_BASE = 0.02;
export const TRANS_TIE_STEP = 1e-4;

// Display colours for the UI — not used by the solver math.
export const GEM_HEX = {
  ruby: "#e2445c", amethyst: "#a259d9", topaz: "#e0a11b",
  emerald: "#35c26b", sapphire: "#3d7fe0", diamond: "#cfd8e6",
};

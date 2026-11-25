// ============================================================
// src/utils/warRange.js
// Politics & War war range rule (P&W wiki "Nation Formulas"):
//   You can declare on nations scoring between 75% and 250% of
//   YOUR score. (Max was 175% until the August 2023 update.)
// Keep this in ONE place so every feature uses the same rule.
// ============================================================

const WAR_RANGE = Object.freeze({ MIN_RATIO: 0.75, MAX_RATIO: 2.5 });

// Can an attacker with `attackerScore` declare on `targetScore`?
function inWarRange(attackerScore, targetScore) {
  const a = Number(attackerScore) || 0;
  const t = Number(targetScore) || 0;
  return t >= a * WAR_RANGE.MIN_RATIO && t <= a * WAR_RANGE.MAX_RATIO;
}

// Targets an attacker can hit
function targetRange(attackerScore) {
  const a = Number(attackerScore) || 0;
  return { min: a * WAR_RANGE.MIN_RATIO, max: a * WAR_RANGE.MAX_RATIO };
}

// Attackers that can hit a given target
function attackerRange(targetScore) {
  const t = Number(targetScore) || 0;
  return { min: t / WAR_RANGE.MAX_RATIO, max: t / WAR_RANGE.MIN_RATIO };
}

module.exports = { WAR_RANGE, inWarRange, targetRange, attackerRange };

// ============================================================
// src/systems/military/blitzPlanner.js
//
// Automatic blitz planner.
//
// Goal: give EVERY enemy member attackers, spread the work across
// our members as evenly as possible, never break war range, and
// put our strongest members on the most dangerous enemies.
//
// How it works (layered min-cost max-flow):
//   Layer 1: every enemy gets ONE attacker
//   Layer 2: every enemy gets a SECOND attacker  ... up to N
//   Each layer is solved optimally. The cost of using a member
//   rises steeply with every target they already hold, so members
//   with no assignment are always preferred over ones that already
//   have one. Among equally-loaded members the best matchup wins,
//   and matchup quality counts more for dangerous enemies.
// ============================================================

const { getAllianceMembers } = require('../../utils/pwApi');
const { inWarRange, attackerRange, WAR_RANGE } = require('../../utils/warRange');

const MAX_OFFENSIVE_SLOTS = 5;
const MAX_DEFENSIVE_SLOTS = 3;
const INACTIVE_DAYS       = 7;

// Cost scale. LOAD_STEP dwarfs any matchup cost, which makes
// "spread the load" a hard priority and "best matchup" the tie-breaker.
const LOAD_STEP = 100000;
const MATCH_W   = 100;   // 0..100 base cost for a bad matchup
const COVER_W   = 4000;  // bonus for covering dangerous targets first

const num = v => Number(v) || 0;

// ── Combat maths ─────────────────────────────────────────────
// P&W ground value: armed soldier 1.75, tank 40 (wiki "War")
const groundPower = n => num(n.soldiers) * 1.75 + num(n.tanks) * 40;
const ratio = (a, b) => (a + b === 0 ? 0.5 : a / (a + b));

// 0..1 — how well `att` matches up against `tgt`
function advantage(att, tgt) {
  return 0.45 * ratio(num(att.aircraft), num(tgt.aircraft)) +
         0.35 * ratio(groundPower(att), groundPower(tgt)) +
         0.20 * ratio(num(att.ships),    num(tgt.ships));
}

function computeThreats(targets) {
  const max = {
    air:    Math.max(1, ...targets.map(t => num(t.aircraft))),
    ground: Math.max(1, ...targets.map(t => groundPower(t))),
    ships:  Math.max(1, ...targets.map(t => num(t.ships))),
    cities: Math.max(1, ...targets.map(t => num(t.num_cities))),
  };
  for (const t of targets) {
    const raw =
      0.35 * (num(t.aircraft) / max.air) +
      0.25 * (groundPower(t)  / max.ground) +
      0.10 * (num(t.ships)    / max.ships) +
      0.10 * (num(t.num_cities) / max.cities) +
      0.10 * Math.min(num(t.missiles) / 10, 1) +
      0.10 * Math.min(num(t.nukes) / 3, 1);
    t.threatRaw = Math.max(0, Math.min(1, raw));
    t.threat    = Math.round(t.threatRaw * 100);
  }
}

// ── Min-cost max-flow (successive shortest paths, SPFA) ──────
class MinCostFlow {
  constructor(n) {
    this.n = n;
    this.g = Array.from({ length: n }, () => []);
    this.e = [];
  }
  addEdge(u, v, cap, cost) {
    this.g[u].push(this.e.length); this.e.push({ to: v, cap, cost });
    this.g[v].push(this.e.length); this.e.push({ to: u, cap: 0, cost: -cost });
    return this.e.length - 2;
  }
  run(s, t) {
    let flow = 0;
    for (;;) {
      const dist = new Array(this.n).fill(Infinity);
      const inq  = new Array(this.n).fill(false);
      const prev = new Array(this.n).fill(-1);
      dist[s] = 0;
      const q = [s];
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi]; inq[u] = false;
        for (const id of this.g[u]) {
          const ed = this.e[id];
          if (ed.cap > 0 && dist[u] + ed.cost < dist[ed.to]) {
            dist[ed.to] = dist[u] + ed.cost;
            prev[ed.to] = id;
            if (!inq[ed.to]) { inq[ed.to] = true; q.push(ed.to); }
          }
        }
      }
      if (dist[t] === Infinity) break;
      let f = Infinity;
      for (let v = t; v !== s; v = this.e[prev[v] ^ 1].to) f = Math.min(f, this.e[prev[v]].cap);
      for (let v = t; v !== s; v = this.e[prev[v] ^ 1].to) {
        this.e[prev[v]].cap     -= f;
        this.e[prev[v] ^ 1].cap += f;
      }
      flow += f;
    }
    return flow;
  }
}

// ── Helpers ──────────────────────────────────────────────────
function daysSince(lastActive, now) {
  if (!lastActive) return 0;
  let s = String(lastActive).trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(s)) s += 'Z';
  const t = Date.parse(s);
  return isNaN(t) ? 0 : (now - t) / 86400000;
}

// ============================================================
// PURE PLANNER — no API calls, easy to test
// ============================================================
function buildPlan(ourMembers, enemyMembers, attackersPerTarget = 3, options = {}) {
  const opts = { maxPerMember: MAX_OFFENSIVE_SLOTS, includeBeige: false, now: Date.now(), ...options };
  const k    = Math.max(1, Math.min(5, parseInt(attackersPerTarget) || 3));
  const capLimit = Math.max(1, Math.min(MAX_OFFENSIVE_SLOTS, parseInt(opts.maxPerMember) || MAX_OFFENSIVE_SLOTS));

  // ── Our attacker pool ──────────────────────────────────────
  const pool = [];
  const excludedMembers = [];
  for (const m of ourMembers) {
    const reason =
      num(m.vacation_mode_turns) > 0 ? 'On vacation mode' :
      daysSince(m.last_active, opts.now) > INACTIVE_DAYS ? `Inactive for more than ${INACTIVE_DAYS} days` :
      (num(m.soldiers) + num(m.tanks) + num(m.aircraft) + num(m.ships)) === 0 ? 'No military units' :
      num(m.offensive_wars_count) >= MAX_OFFENSIVE_SLOTS ? 'No open offensive slots' : null;
    if (reason) { excludedMembers.push({ member: m, reason }); continue; }
    const openSlots = MAX_OFFENSIVE_SLOTS - num(m.offensive_wars_count);
    pool.push({ ...m, openSlots, cap: Math.min(openSlots, capLimit), load: 0, matches: [] });
  }

  // ── Enemy targets ──────────────────────────────────────────
  const targets = [];
  const skippedTargets = [];
  for (const m of enemyMembers) {
    const reason =
      num(m.vacation_mode_turns) > 0 ? 'On vacation mode' :
      (!opts.includeBeige && num(m.beige_turns) > 0) ? `In beige (${num(m.beige_turns) * 2}h left)` :
      num(m.defensive_wars_count) >= MAX_DEFENSIVE_SLOTS ? 'Already has 3 defensive wars' : null;
    if (reason) { skippedTargets.push({ target: m, reason }); continue; }
    const openDefSlots = MAX_DEFENSIVE_SLOTS - num(m.defensive_wars_count);
    targets.push({ ...m, openDefSlots, need: Math.min(k, openDefSlots), assigned: [], assignedIds: new Set() });
  }
  computeThreats(targets);
  targets.sort((a, b) => b.threat - a.threat || num(b.score) - num(a.score));
  targets.forEach((t, i) => { t.priority = i + 1; });

  // ── Layered assignment ─────────────────────────────────────
  for (let layer = 1; layer <= k; layer++) {
    const atts = pool.filter(a => a.load < a.cap);
    const tgts = targets.filter(t => t.assigned.length < Math.min(layer, t.need));
    if (atts.length === 0 || tgts.length === 0) continue;

    const S = 0, T = 1, A0 = 2, T0 = 2 + atts.length;
    const net = new MinCostFlow(2 + atts.length + tgts.length);

    // source -> attacker: one arc per remaining slot, each pricier than the last
    atts.forEach((a, i) => {
      for (let s = 0; s < a.cap - a.load; s++) net.addEdge(S, A0 + i, 1, LOAD_STEP * (a.load + s));
    });

    // attacker -> target (only legal, not-yet-used pairings)
    const pairEdges = [];
    atts.forEach((a, i) => {
      tgts.forEach((t, j) => {
        if (t.assignedIds.has(a.id)) return;
        if (!inWarRange(a.score, t.score)) return;               // WAR RANGE RULE
        const adv   = advantage(a, t);
        const match = Math.round((1 - adv) * MATCH_W * (1 + 1.5 * t.threatRaw) * 10);
        const cover = Math.round((1 - t.threatRaw) * COVER_W);
        const id = net.addEdge(A0 + i, T0 + j, 1, match + cover);
        pairEdges.push({ id, a, t, adv });
      });
    });

    tgts.forEach((t, j) => net.addEdge(T0 + j, T, 1, 0));
    net.run(S, T);

    for (const pe of pairEdges) {
      if (net.e[pe.id].cap === 0) {            // flow went through this pairing
        pe.t.assigned.push({ ...pe.a, advantage: pe.adv });
        pe.t.assignedIds.add(pe.a.id);
        pe.a.load++;
        pe.a.matches.push({ target: pe.t, advantage: pe.adv });
      }
    }
  }

  // ── Build results ──────────────────────────────────────────
  const assignments = targets.map(t => {
    t.assigned.sort((x, y) => y.advantage - x.advantage);
    return {
      target: t,
      attackers: t.assigned.map(a => ({ ...a, load: pool.find(p => p.id === a.id)?.load || 1 })),
      neededAttackers: t.need,
      fullySlotted: t.assigned.length >= t.need,
    };
  });

  const unmatched = [];
  const uncovered = [];
  for (const a of assignments) {
    if (a.attackers.length >= a.neededAttackers) continue;
    const inRange = pool.filter(p => inWarRange(p.score, a.target.score));
    const rng = attackerRange(a.target.score);
    const reason = inRange.length === 0
      ? `No active member in range (needs NS ${Math.round(rng.min).toLocaleString()}–${Math.round(rng.max).toLocaleString()})`
      : `In-range members are already at their assignment limit`;
    a.shortReason = reason;
    unmatched.push({ target: a.target, assigned: a.attackers.length, needed: a.neededAttackers, reason });
    if (a.attackers.length === 0) uncovered.push({ target: a.target, reason });
  }

  const unusedMembers = pool.filter(p => p.load === 0).map(p => ({
    ...p,
    reason: targets.some(t => inWarRange(p.score, t.score))
      ? 'Surplus — every target already has its attackers'
      : 'No enemy target in war range',
  }));

  const byMember = pool.filter(p => p.load > 0)
    .map(p => ({ member: p, targets: p.matches }))
    .sort((x, y) => y.member.load - x.member.load || num(y.member.score) - num(x.member.score));

  const loads = pool.map(p => p.load);
  const totalAssignments = loads.reduce((s, v) => s + v, 0);
  const fullySlottedCount = assignments.filter(a => a.fullySlotted).length;
  const coveredCount = assignments.filter(a => a.attackers.length > 0).length;

  return {
    options: { attackersPerTarget: k, maxPerMember: capLimit, includeBeige: opts.includeBeige },
    warRange: { min: WAR_RANGE.MIN_RATIO, max: WAR_RANGE.MAX_RATIO },
    ourMemberCount: pool.length,
    enemyMemberCount: targets.length,
    totalTargets: targets.length,
    assignments, unmatched, uncovered, unusedMembers, excludedMembers, skippedTargets, byMember,
    totalAssignments, fullySlottedCount, coveredCount,
    coverage:    targets.length ? Math.round((fullySlottedCount / targets.length) * 100) : 0,
    coverageAny: targets.length ? Math.round((coveredCount / targets.length) * 100) : 0,
    loadStats: {
      used: loads.filter(v => v > 0).length,
      idle: loads.filter(v => v === 0).length,
      max:  loads.length ? Math.max(...loads) : 0,
      min:  loads.length ? Math.min(...loads) : 0,
      avgUsed: loads.filter(v => v > 0).length
        ? totalAssignments / loads.filter(v => v > 0).length : 0,
    },
    attackersPerTarget: k,
  };
}

// ============================================================
// Public entry point — fetches both rosters, then plans
// ============================================================
async function planBlitz(guildId, ourAllianceId, enemyAllianceId, attackersPerTarget = 3, options = {}) {
  const [ourMembers, enemyMembers] = await Promise.all([
    getAllianceMembers(ourAllianceId),
    getAllianceMembers(enemyAllianceId),
  ]);
  return buildPlan(ourMembers, enemyMembers, attackersPerTarget, options);
}

module.exports = { planBlitz, buildPlan, advantage, groundPower };

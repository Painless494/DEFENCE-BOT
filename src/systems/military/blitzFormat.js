// ============================================================
// src/systems/military/blitzFormat.js
// Pure formatting helpers for blitz plans (no Discord objects):
// CSV exports and compact target cards showing FULL military
// (soldiers, tanks, aircraft, ships, missiles, nukes) for both
// the enemy and every planned attacker.
// ============================================================

const nat = v => Number(v) || 0;
const fmt = v => nat(v).toLocaleString('en-US');

// 15,200 -> 15.2k   1,250,000 -> 1.3M   (keeps cards short)
function compact(v) {
  const n = nat(v);
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

function milLine(n) {
  return `👮${compact(n.soldiers)} 🚗${compact(n.tanks)} ✈️${compact(n.aircraft)} ` +
         `🚢${compact(n.ships)} 🚀${compact(n.missiles)} ☢️${compact(n.nukes)}`;
}

function threatEmoji(t) { return t >= 70 ? '🔴' : t >= 50 ? '🟠' : t >= 30 ? '🟡' : '🟢'; }
function pct(x) { return `${Math.round(nat(x) * 100)}%`; }
function nationUrl(id) { return `https://politicsandwar.com/nation/id=${id}`; }
function linkedId(map, id) { return map.get(id) || map.get(String(id)) || null; }

// ── CSV ──────────────────────────────────────────────────────
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// BOM so Excel reads UTF-8 names correctly
function toCsv(rows) { return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

// One row per pairing, grouped by enemy in priority order
function buildByTargetCsv(plan, discordMap) {
  const rows = [[
    'Priority', 'Threat', 'Target', 'Target ID', 'Target NS', 'Target Cities',
    'Target Soldiers', 'Target Tanks', 'Target Aircraft', 'Target Ships', 'Target Missiles', 'Target Nukes',
    'Target Open Def Slots', 'Attacker #', 'Attacker', 'Attacker ID', 'Discord Linked',
    'Attacker NS', 'Attacker Cities', 'Attacker Soldiers', 'Attacker Tanks', 'Attacker Aircraft',
    'Attacker Ships', 'Attacker Missiles', 'Attacker Nukes', 'Matchup %', 'Attacker Total Targets',
    'Status', 'Target Link',
  ]];
  for (const a of plan.assignments) {
    const t = a.target;
    const head = [t.priority, t.threat, t.nation_name, t.id, Math.round(nat(t.score)), t.num_cities,
      t.soldiers, t.tanks, t.aircraft, t.ships, t.missiles, t.nukes, t.openDefSlots];
    const status = a.attackers.length >= a.neededAttackers ? 'OK'
      : `SHORT ${a.attackers.length}/${a.neededAttackers}: ${a.shortReason || ''}`;
    if (a.attackers.length === 0) {
      rows.push([...head, '', '', '', '', '', '', '', '', '', '', '', '', '', status, nationUrl(t.id)]);
      continue;
    }
    a.attackers.forEach((at, i) => rows.push([
      ...head, i + 1, at.nation_name, at.id, linkedId(discordMap, at.id) ? 'Yes' : 'No',
      Math.round(nat(at.score)), at.num_cities, at.soldiers, at.tanks, at.aircraft, at.ships,
      at.missiles, at.nukes, Math.round(nat(at.advantage) * 100), at.load, status, nationUrl(t.id),
    ]));
  }
  if (plan.skippedTargets.length) {
    rows.push([]);
    rows.push(['--- ENEMIES NOT PLANNED ---']);
    rows.push(['Target', 'Target ID', 'NS', 'Reason']);
    plan.skippedTargets.forEach(s => rows.push([s.target.nation_name, s.target.id, Math.round(nat(s.target.score)), s.reason]));
  }
  return toCsv(rows);
}

// One row per member — their personal target list
function buildByMemberCsv(plan, discordMap) {
  const maxT = Math.max(1, ...plan.byMember.map(b => b.targets.length));
  const header = ['Member', 'Nation ID', 'Discord Linked', 'NS', 'Cities', 'Soldiers', 'Tanks', 'Aircraft',
    'Ships', 'Missiles', 'Nukes', 'Open Offensive Slots', 'Assigned Targets'];
  for (let i = 1; i <= maxT; i++) header.push(`Target ${i}`);
  header.push('Notes');
  const rows = [header];

  const base = m => [m.nation_name, m.id, linkedId(discordMap, m.id) ? 'Yes' : 'No', Math.round(nat(m.score)),
    m.num_cities, m.soldiers, m.tanks, m.aircraft, m.ships, m.missiles, m.nukes];

  for (const b of plan.byMember) {
    const cells = b.targets.map(x =>
      `${x.target.nation_name} (NS ${fmt(Math.round(x.target.score))}, ${Math.round(x.advantage * 100)}% match, ID ${x.target.id})`);
    while (cells.length < maxT) cells.push('');
    rows.push([...base(b.member), b.member.openSlots, b.targets.length, ...cells, '']);
  }
  for (const u of plan.unusedMembers) {
    rows.push([...base(u), u.openSlots, 0, ...Array(maxT).fill(''), u.reason]);
  }
  for (const e of plan.excludedMembers) {
    rows.push([...base(e.member), '', 0, ...Array(maxT).fill(''), `Excluded: ${e.reason}`]);
  }
  return toCsv(rows);
}

// ── Discord target cards (full military for both sides) ──────
function buildTargetCards(plan, discordMap) {
  return plan.assignments.map(a => {
    const t = a.target;
    const lines = [
      `**#${t.priority}** ${threatEmoji(t.threat)} [${t.nation_name}](${nationUrl(t.id)}) · NS ${fmt(Math.round(t.score))} · 🏙️${t.num_cities} · Threat ${t.threat}`,
      `${milLine(t)}`,
    ];
    if (a.attackers.length === 0) {
      lines.push(`↳ ❌ ${a.shortReason || 'No attackers available'}`);
    } else {
      for (const at of a.attackers) {
        const d = linkedId(discordMap, at.id);
        lines.push(`↳ ${d ? `<@${d}> ` : ''}**${at.nation_name}** · NS ${fmt(Math.round(at.score))} · 🏙️${at.num_cities} · ${pct(at.advantage)} match`);
        lines.push(`   ${milLine(at)}`);
      }
      if (a.attackers.length < a.neededAttackers) {
        lines.push(`↳ ⚠️ Only ${a.attackers.length}/${a.neededAttackers} attackers — ${a.shortReason}`);
      }
    }
    return lines.join('\n');
  });
}

// Pack blocks into embed-sized pages (Discord: 4096 chars per description)
function paginate(blocks, maxChars = 3800, maxPages = 8) {
  const pages = [];
  let cur = '';
  let used = 0;
  for (const b of blocks) {
    if (pages.length >= maxPages) break;
    if (cur && (cur.length + b.length + 2) > maxChars) { pages.push(cur); cur = ''; }
    if (pages.length >= maxPages) break;
    cur += (cur ? '\n\n' : '') + b;
    used++;
  }
  if (cur && pages.length < maxPages) pages.push(cur);
  return { pages, shown: used, hidden: Math.max(0, blocks.length - used) };
}

// Short list of problems for the summary embed
function describeProblems(plan, limit = 5) {
  const lines = plan.unmatched.slice(0, limit).map(u =>
    `• **${u.target.nation_name}** ${u.assigned}/${u.needed} — ${u.reason}`);
  if (plan.unmatched.length > limit) lines.push(`_...and ${plan.unmatched.length - limit} more (see CSV)_`);
  return lines.join('\n');
}

module.exports = {
  fmt, compact, milLine, threatEmoji, pct, linkedId,
  buildByTargetCsv, buildByMemberCsv, buildTargetCards, paginate, describeProblems,
};

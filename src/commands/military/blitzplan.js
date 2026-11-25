// ============================================================
// src/commands/military/blitzplan.js
// /blitzplan generate — plan who hits whom across a whole alliance
// /blitzplan convert  — turn the plan into real assignments
// ============================================================

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { queryOne, run } = require('../../utils/database');
const { resolveAlliance } = require('../../utils/pwApi');
const { planBlitz } = require('../../systems/military/blitzPlanner');
const { buildNationToDiscordMap } = require('../../utils/nationLink');
const {
  fmt, buildByTargetCsv, buildByMemberCsv, buildTargetCards, paginate, describeProblems,
} = require('../../systems/military/blitzFormat');

// Options shared by generate and convert so both build the SAME plan
function addPlanOptions(sub) {
  return sub
    .addIntegerOption(opt =>
      opt.setName('attackers')
        .setDescription('Attackers to assign per enemy member (default: 3)')
        .addChoices(
          { name: '1 attacker per target', value: 1 },
          { name: '2 attackers per target', value: 2 },
          { name: '3 attackers per target (recommended)', value: 3 },
          { name: '4 attackers per target', value: 4 },
          { name: '5 attackers per target', value: 5 },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('max_per_member')
        .setDescription('Most enemies any one of our members may be given (default: all their open slots)')
        .setMinValue(1).setMaxValue(5)
    )
    .addBooleanOption(opt =>
      opt.setName('include_beige')
        .setDescription('Also plan for enemies currently in beige (default: no — they cannot be declared on yet)')
    );
}

const planOpts = interaction => ({
  attackers:    interaction.options.getInteger('attackers') || 3,
  maxPerMember: interaction.options.getInteger('max_per_member') || 5,
  includeBeige: interaction.options.getBoolean('include_beige') ?? false,
});

module.exports = {
  data: new SlashCommandBuilder()
    .setName('blitzplan')
    .setDescription('Automatically plan a blitz: every enemy member gets attackers, spread evenly, in war range')

    .addSubcommand(sub => addPlanOptions(
      sub.setName('generate')
        .setDescription('Generate a blitz plan against an enemy alliance')
        .addStringOption(opt =>
          opt.setName('enemy').setDescription('Enemy alliance name, ID, or P&W link').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('output')
            .setDescription('How to show the plan')
            .addChoices(
              { name: '📊 Summary + CSV files (default)', value: 'csv' },
              { name: '📋 Summary + CSV + target cards in Discord', value: 'embed' },
            )
        )
    ))

    .addSubcommand(sub => addPlanOptions(
      sub.setName('convert')
        .setDescription('Turn a blitz plan into real assignments and a blitz operation')
        .addStringOption(opt =>
          opt.setName('enemy').setDescription('Same enemy alliance you generated the plan for').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('blitz_name').setDescription('Name for this blitz e.g. "Operation Sunrise"').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('launch_time').setDescription('Launch time UTC e.g. 2026-06-30 18:00 (optional)')
        )
    )),

  requiredRole: 'military',

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    const guildRow = queryOne('SELECT alliance_id FROM guilds WHERE guild_id = ?', [interaction.guildId]);
    if (!guildRow?.alliance_id) {
      return interaction.reply({ content: '❌ No alliance configured. Use `/config alliance` first.', flags: 64 });
    }

    // ── GENERATE ─────────────────────────────────────────────
    if (sub === 'generate') {
      await interaction.deferReply();
      const enemyInput = interaction.options.getString('enemy');
      const output     = interaction.options.getString('output') || 'csv';
      const o          = planOpts(interaction);

      await interaction.editReply(`🔍 Looking up **${enemyInput}**...`);
      const enemy = await resolveAlliance(enemyInput);
      if (!enemy) {
        return interaction.editReply(`❌ Could not find alliance **"${enemyInput}"**. Try name, ID, or P&W link.`);
      }

      await interaction.editReply(`⏳ Planning the blitz against **${enemy.name}**...`);
      let plan;
      try {
        plan = await planBlitz(interaction.guildId, guildRow.alliance_id, enemy.id, o.attackers,
          { maxPerMember: o.maxPerMember, includeBeige: o.includeBeige });
      } catch (err) {
        return interaction.editReply(`❌ Failed to generate plan: ${err.message}`);
      }

      if (plan.ourMemberCount === 0) {
        return interaction.editReply('❌ None of our members are available to attack (all on vacation, inactive, out of slots, or without military).');
      }
      if (plan.totalTargets === 0) {
        return interaction.editReply(`❌ **${enemy.name}** has no members that can be targeted right now (vacation, beige, or already triple-slotted).`);
      }

      const discordMap = buildNationToDiscordMap(interaction.guildId);
      const ls  = plan.loadStats;
      const exc = {};
      plan.excludedMembers.forEach(e => { exc[e.reason] = (exc[e.reason] || 0) + 1; });
      const skip = {};
      plan.skippedTargets.forEach(s => { const k = s.reason.replace(/\s*\(.*\)/, ''); skip[k] = (skip[k] || 0) + 1; });
      const list = obj => Object.entries(obj).map(([k, v]) => `${k}: **${v}**`).join(' · ') || 'none';

      const color = plan.coverage >= 90 ? 0x2ecc71 : plan.coverage >= 70 ? 0xf1c40f : plan.coverage >= 50 ? 0xe67e22 : 0xe74c3c;

      const summary = new EmbedBuilder()
        .setTitle(`💥 Blitz Plan — vs ${enemy.name}`)
        .setColor(color)
        .setDescription(
          `**${plan.attackersPerTarget} attacker(s) per enemy** · enemies ranked by threat (most dangerous first) · ` +
          `strongest members go to the most dangerous enemies.\n` +
          `📏 War range rule applied: targets must be **75%–250%** of the attacker's score.`
        )
        .addFields(
          {
            name: '🎯 Coverage',
            value:
              `Enemies with at least one attacker: **${plan.coveredCount} / ${plan.totalTargets}** (${plan.coverageAny}%)\n` +
              `Fully staffed: **${plan.fullySlottedCount} / ${plan.totalTargets}** (${plan.coverage}%)\n` +
              `Total assignments: **${plan.totalAssignments}**`,
          },
          {
            name: '⚖️ How evenly the work is spread',
            value:
              `Members used: **${ls.used} / ${plan.ourMemberCount}** · idle: **${ls.idle}**\n` +
              `Average targets per used member: **${ls.avgUsed.toFixed(1)}** · busiest member: **${ls.max}**`,
          },
          {
            name: '👥 Our side',
            value: `Available attackers: **${plan.ourMemberCount}**\nExcluded — ${list(exc)}`.slice(0, 1020),
            inline: true,
          },
          {
            name: '⚔️ Enemy side',
            value: `Targetable: **${plan.totalTargets}**\nNot planned — ${list(skip)}`.slice(0, 1020),
            inline: true,
          },
        )
        .setTimestamp();

      if (plan.unmatched.length > 0) {
        summary.addFields({
          name: `⚠️ Enemies without a full team (${plan.unmatched.length})`,
          value: describeProblems(plan, 5).slice(0, 1020),
        });
      }
      summary.setFooter({
        text: `Next: /blitzplan convert enemy:${enemy.name} blitz_name:"Operation X" to create the assignments`.slice(0, 2000),
      });

      const safe = (enemy.name || 'enemy').replace(/[^a-z0-9]/gi, '_').slice(0, 40);
      const files = [
        new AttachmentBuilder(Buffer.from(buildByTargetCsv(plan, discordMap), 'utf8'), { name: `blitz_${safe}_by_target.csv` }),
        new AttachmentBuilder(Buffer.from(buildByMemberCsv(plan, discordMap), 'utf8'), { name: `blitz_${safe}_by_member.csv` }),
      ];

      await interaction.editReply({ content: '', embeds: [summary], files });

      // ── Target cards in Discord (full military for both sides) ──
      if (output === 'embed') {
        const { pages, hidden } = paginate(buildTargetCards(plan, discordMap), 3800, 8);
        for (let i = 0; i < pages.length; i++) {
          const card = new EmbedBuilder()
            .setTitle(i === 0 ? `📋 Blitz Plan vs ${enemy.name} — target cards` : `📋 Blitz Plan (page ${i + 1}/${pages.length})`)
            .setColor(color)
            .setDescription(pages[i])
            .setFooter({
              text: `👮 soldiers 🚗 tanks ✈️ aircraft 🚢 ships 🚀 missiles ☢️ nukes` +
                    (i === pages.length - 1 && hidden > 0 ? ` · ${hidden} more target(s) in the CSV` : ` · page ${i + 1}/${pages.length}`),
            });
          await interaction.followUp({ embeds: [card] });
        }
      }
      return;
    }

    // ── CONVERT ──────────────────────────────────────────────
    if (sub === 'convert') {
      await interaction.deferReply();
      const enemyInput = interaction.options.getString('enemy');
      const blitzName  = interaction.options.getString('blitz_name');
      const launchStr  = interaction.options.getString('launch_time') || null;
      const o          = planOpts(interaction);

      await interaction.editReply(`⏳ Re-planning against **${enemyInput}** and creating assignments...`);
      const enemy = await resolveAlliance(enemyInput);
      if (!enemy) return interaction.editReply(`❌ Could not find **"${enemyInput}"**.`);

      let plan;
      try {
        plan = await planBlitz(interaction.guildId, guildRow.alliance_id, enemy.id, o.attackers,
          { maxPerMember: o.maxPerMember, includeBeige: o.includeBeige });
      } catch (err) {
        return interaction.editReply(`❌ Failed to generate plan: ${err.message}`);
      }
      if (plan.totalAssignments === 0) {
        return interaction.editReply('❌ The plan has no assignments to create (nobody available or nobody in range).');
      }

      let launchTime = null;
      if (launchStr) {
        const parsed = new Date(launchStr + ' UTC');
        if (!isNaN(parsed.getTime())) launchTime = parsed.toISOString();
      }

      run(
        `INSERT INTO blitz_operations (guild_id, name, description, launch_time, created_by, status)
         VALUES (?, ?, ?, ?, ?, 'planning')`,
        [interaction.guildId, blitzName,
         `Auto-generated vs ${enemy.name} | ${plan.attackersPerTarget} attackers/target`,
         launchTime, interaction.user.id]
      );
      const blitzId = queryOne(
        `SELECT id FROM blitz_operations WHERE guild_id = ? AND name = ? ORDER BY created_at DESC LIMIT 1`,
        [interaction.guildId, blitzName]
      )?.id;

      const expiresAt = launchTime
        ? new Date(new Date(launchTime).getTime() + 2 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      const discordMap = buildNationToDiscordMap(interaction.guildId);
      let created = 0;
      const unlinked = new Map();

      for (const assignment of plan.assignments) {
        for (const attacker of assignment.attackers) {
          const did      = discordMap.get(attacker.id) || discordMap.get(String(attacker.id));
          const isLinked = !!did;
          if (!isLinked) unlinked.set(attacker.id, attacker.nation_name);

          run(
            `INSERT INTO target_assignments
             (guild_id, target_nation_id, target_nation_name, assigned_to_discord_id,
              assigned_by_discord_id, status, priority, notes, expires_at)
             VALUES (?, ?, ?, ?, ?, 'assigned', 'high', ?, ?)`,
            [
              interaction.guildId, assignment.target.id, assignment.target.nation_name,
              did || interaction.user.id, interaction.user.id,
              `[Blitz: ${blitzName}] Attacker: ${attacker.nation_name} (P&W ID: ${attacker.id})` +
                `${isLinked ? '' : ' — NOT LINKED, reassign manually'}`,
              expiresAt,
            ]
          );
          created++;
        }
      }

      const launchTs = launchTime ? Math.floor(new Date(launchTime).getTime() / 1000) : null;
      const embed = new EmbedBuilder()
        .setTitle(`💥 Blitz Created — ${blitzName}`)
        .setColor(0xe74c3c)
        .addFields(
          { name: '🆔 Blitz ID', value: `#${blitzId}`, inline: true },
          { name: '⚔️ Enemy', value: enemy.name, inline: true },
          { name: '📋 Assignments Created', value: `${created}`, inline: true },
          { name: '🎯 Coverage', value: `${plan.coveredCount}/${plan.totalTargets} enemies covered · ${plan.fullySlottedCount} fully staffed (${plan.coverage}%)`, inline: false },
          { name: '⚖️ Spread', value: `${plan.loadStats.used} members used · busiest has ${plan.loadStats.max} target(s)`, inline: false },
          { name: '⏰ Launch Time', value: launchTs ? `<t:${launchTs}:F> (<t:${launchTs}:R>)` : 'Not set — use `/blitz ping` when ready', inline: false },
        )
        .setFooter({ text: `Use /blitz view ${blitzId} to see the blitz | /blitz ping ${blitzId} to alert members` })
        .setTimestamp();

      embed.setDescription(
        unlinked.size === 0
          ? `✅ Every attacker is linked, so each assignment was sent to the right member.`
          : `⚠️ **${unlinked.size} attacker(s) have no linked Discord account**, so their assignments were attributed to you — ` +
            `ask them to run \`/link set\`, or reassign manually:\n` +
            [...unlinked.values()].slice(0, 15).map(n => `• ${n}`).join('\n') +
            (unlinked.size > 15 ? `\n_...and ${unlinked.size - 15} more_` : '')
      );
      return interaction.editReply({ content: '', embeds: [embed] });
    }
  },
};

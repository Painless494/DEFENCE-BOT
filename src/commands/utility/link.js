// ============================================================
// src/commands/utility/link.js
// Fixes: stale links to departed Discord users, admin unlink,
//        admin_set conflict crash, cleanup of stale links
// ============================================================

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { run, queryOne, query } = require('../../utils/database');
const { resolveNation } = require('../../utils/pwApi');
const { checkPermission } = require('../../utils/permissions');

// True if the user is still in the server. Only a definite
// "Unknown Member" (10007) counts as gone, so a network hiccup
// never causes a wrongful removal.
async function isInGuild(guild, userId) {
  if (guild.members.cache.has(userId)) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch (err) {
    if (err.code === 10007) return false;
    return true;
  }
}

// Replace any existing link for this Discord user OR this nation
function saveLink(guildId, discordUserId, nation) {
  const nationId = parseInt(nation.id);
  run(
    'DELETE FROM nation_links WHERE guild_id = ? AND (discord_user_id = ? OR nation_id = ?)',
    [guildId, discordUserId, nationId]
  );
  run(
    `INSERT INTO nation_links (guild_id, discord_user_id, nation_id, nation_name, alliance_id, alliance_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      guildId, discordUserId, nationId, nation.nation_name,
      nation.alliance_id ? parseInt(nation.alliance_id) : null,
      nation.alliance?.name || null,
    ]
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord account to your P&W nation')

    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Register your P&W nation')
        .addStringOption(opt =>
          opt.setName('nation').setDescription('Your nation name, ID, or P&W link').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('remove').setDescription('Unlink your own nation from your Discord account')
    )
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check which nation a Discord member has linked')
        .addUserOption(opt =>
          opt.setName('member').setDescription('Member to check (blank = yourself)')
        )
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Show all linked members (Military+ only)')
    )
    .addSubcommand(sub =>
      sub.setName('admin_set')
        .setDescription('Force-link a nation to a Discord member (Military+ only)')
        .addUserOption(opt =>
          opt.setName('member').setDescription('Discord member to link').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('nation').setDescription('Nation name, ID, or P&W link').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('unlink')
        .setDescription('Remove a link by nation name, nation ID, or Discord user ID (Military+ only)')
        .addStringOption(opt =>
          opt.setName('target')
            .setDescription('Nation name, nation ID, or Discord user ID / mention')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('cleanup')
        .setDescription('Remove links for Discord users who left the server (Military+ only)')
        .addBooleanOption(opt =>
          opt.setName('preview').setDescription('Only show what would be removed (default: false)')
        )
    ),

  requiredRole: null,

  async execute(interaction) {
    const sub     = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    // ── SET ──────────────────────────────────────────────────
    if (sub === 'set') {
      await interaction.deferReply({ flags: 64 });
      const input = interaction.options.getString('nation');
      await interaction.editReply(`🔍 Looking up **${input}**...`);

      const nation = await resolveNation(input);
      if (!nation) {
        return interaction.editReply(`❌ Could not find nation **"${input}"**. Try the exact name, nation ID, or profile link.`);
      }

      let takeoverNote = '';
      const existing = queryOne(
        'SELECT * FROM nation_links WHERE guild_id = ? AND nation_id = ?',
        [guildId, parseInt(nation.id)]
      );

      if (existing && existing.discord_user_id !== interaction.user.id) {
        const stillHere = await isInGuild(interaction.guild, existing.discord_user_id);
        if (stillHere) {
          return interaction.editReply(
            `❌ **${nation.nation_name}** is already linked to <@${existing.discord_user_id}>.\n` +
            `If that's not you, ask a Military Officer to fix it with \`/link admin_set\` or \`/link unlink\`.`
          );
        }
        takeoverNote = `\n♻️ The previous Discord account linked to this nation is no longer in the server, so the link was transferred to you.`;
      }

      saveLink(guildId, interaction.user.id, nation);

      const embed = new EmbedBuilder()
        .setTitle('✅ Nation Linked!')
        .setColor(0x2ecc71)
        .setDescription(`Your Discord account is now linked to your P&W nation.${takeoverNote}`)
        .addFields(
          { name: '🏴 Nation',   value: `[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})`, inline: true },
          { name: '🏛️ Alliance', value: nation.alliance?.name || 'None', inline: true },
          { name: '⭐ Score',    value: nation.score?.toLocaleString() || '?', inline: true },
          { name: '🏙️ Cities',  value: `${nation.num_cities ?? '?'}`, inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ content: '', embeds: [embed] });
    }

    // ── REMOVE (self) ────────────────────────────────────────
    if (sub === 'remove') {
      const existing = queryOne(
        'SELECT nation_name FROM nation_links WHERE guild_id = ? AND discord_user_id = ?',
        [guildId, interaction.user.id]
      );
      if (!existing) {
        return interaction.reply({ content: '❌ You don\'t have a nation linked.', flags: 64 });
      }
      run('DELETE FROM nation_links WHERE guild_id = ? AND discord_user_id = ?', [guildId, interaction.user.id]);
      return interaction.reply({ content: `✅ Your link to **${existing.nation_name}** has been removed.`, flags: 64 });
    }

    // ── CHECK ────────────────────────────────────────────────
    if (sub === 'check') {
      const target = interaction.options.getUser('member') || interaction.user;
      const link = queryOne(
        'SELECT * FROM nation_links WHERE guild_id = ? AND discord_user_id = ?',
        [guildId, target.id]
      );
      if (!link) {
        return interaction.reply({
          content: target.id === interaction.user.id
            ? '❌ You haven\'t linked a nation yet. Use `/link set`.'
            : `❌ <@${target.id}> hasn't linked a nation yet.`,
          flags: 64,
        });
      }
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setTitle(`🔗 Linked Nation — ${target.username}`)
          .setColor(0x3498db)
          .addFields(
            { name: '🏴 Nation',   value: `[${link.nation_name}](https://politicsandwar.com/nation/id=${link.nation_id})`, inline: true },
            { name: '🏛️ Alliance', value: link.alliance_name || 'None', inline: true },
            { name: '🆔 Nation ID', value: `${link.nation_id}`, inline: true },
          ).setTimestamp()],
        flags: 64,
      });
    }

    // ── Everything below needs Military+ ─────────────────────
    if (['list', 'admin_set', 'unlink', 'cleanup'].includes(sub) && !checkPermission(interaction, 'military')) {
      return interaction.reply({ content: '❌ You need the Military Officer role for this.', flags: 64 });
    }

    // ── LIST ─────────────────────────────────────────────────
    if (sub === 'list') {
      await interaction.deferReply({ flags: 64 });
      const links = query('SELECT * FROM nation_links WHERE guild_id = ? ORDER BY nation_name ASC', [guildId]).rows;
      if (links.length === 0) {
        return interaction.editReply('📋 No members have linked their nations yet.');
      }

      const lines = [];
      let staleCount = 0;
      for (const l of links) {
        const here = await isInGuild(interaction.guild, l.discord_user_id);
        if (!here) staleCount++;
        lines.push(
          `${here ? `<@${l.discord_user_id}>` : `⚠️ \`${l.discord_user_id}\` _(left server)_`} → ` +
          `**[${l.nation_name}](https://politicsandwar.com/nation/id=${l.nation_id})** (\`${l.nation_id}\`)`
        );
      }

      const pages = [];
      for (let i = 0; i < lines.length; i += 20) pages.push(lines.slice(i, i + 20));

      const embeds = pages.slice(0, 10).map((page, i) =>
        new EmbedBuilder()
          .setTitle(i === 0 ? `🔗 Linked Nations — ${links.length}` : '🔗 Linked Nations (continued)')
          .setColor(0x3498db)
          .setDescription(page.join('\n'))
          .setFooter({ text: i === 0 && staleCount > 0 ? `${staleCount} link(s) belong to users who left — run /link cleanup` : `Page ${i + 1}/${pages.length}` })
      );
      return interaction.editReply({ embeds });
    }

    // ── ADMIN SET ────────────────────────────────────────────
    if (sub === 'admin_set') {
      await interaction.deferReply({ flags: 64 });
      const member = interaction.options.getUser('member');
      const input  = interaction.options.getString('nation');

      const nation = await resolveNation(input);
      if (!nation) return interaction.editReply(`❌ Could not find nation **"${input}"**.`);

      const previous = queryOne(
        'SELECT discord_user_id FROM nation_links WHERE guild_id = ? AND nation_id = ?',
        [guildId, parseInt(nation.id)]
      );

      saveLink(guildId, member.id, nation);

      return interaction.editReply(
        `✅ Linked <@${member.id}> to **[${nation.nation_name}](https://politicsandwar.com/nation/id=${nation.id})**.` +
        (previous && previous.discord_user_id !== member.id
          ? `\n♻️ Replaced the previous link (\`${previous.discord_user_id}\`).` : '')
      );
    }

    // ── UNLINK ───────────────────────────────────────────────
    if (sub === 'unlink') {
      const raw = interaction.options.getString('target').trim();
      const mention = raw.match(/^<@!?(\d{17,20})>$/);
      let rows;

      if (mention || /^\d{17,20}$/.test(raw)) {
        const id = mention ? mention[1] : raw;
        rows = query('SELECT * FROM nation_links WHERE guild_id = ? AND discord_user_id = ?', [guildId, id]).rows;
      } else if (/^\d+$/.test(raw)) {
        rows = query('SELECT * FROM nation_links WHERE guild_id = ? AND nation_id = ?', [guildId, parseInt(raw)]).rows;
      } else {
        rows = query('SELECT * FROM nation_links WHERE guild_id = ? AND LOWER(nation_name) = LOWER(?)', [guildId, raw]).rows;
      }

      if (rows.length === 0) {
        return interaction.reply({ content: `❌ No link found for **${raw}**. Use \`/link list\` to see existing links.`, flags: 64 });
      }

      for (const r of rows) {
        run('DELETE FROM nation_links WHERE id = ?', [r.id]);
      }

      return interaction.reply({
        content: '✅ Unlinked:\n' + rows.map(r => `• **${r.nation_name}** (\`${r.nation_id}\`) ↔ \`${r.discord_user_id}\``).join('\n') +
                 '\n\nThe member can now run `/link set` with their current account.',
        flags: 64,
      });
    }

    // ── CLEANUP ──────────────────────────────────────────────
    if (sub === 'cleanup') {
      await interaction.deferReply({ flags: 64 });
      const preview = interaction.options.getBoolean('preview') ?? false;
      const links   = query('SELECT * FROM nation_links WHERE guild_id = ?', [guildId]).rows;

      const stale = [];
      for (const l of links) {
        if (!(await isInGuild(interaction.guild, l.discord_user_id))) stale.push(l);
      }

      if (stale.length === 0) {
        return interaction.editReply('✅ No stale links found — everyone linked is still in the server.');
      }

      if (!preview) {
        for (const l of stale) run('DELETE FROM nation_links WHERE id = ?', [l.id]);
      }

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle(preview ? `🔍 Stale Links Found — ${stale.length}` : `🧹 Removed ${stale.length} Stale Link(s)`)
          .setColor(preview ? 0xf1c40f : 0x2ecc71)
          .setDescription(
            stale.slice(0, 40).map(l => `• **${l.nation_name}** (\`${l.nation_id}\`) ↔ \`${l.discord_user_id}\``).join('\n').slice(0, 3900) +
            (stale.length > 40 ? `\n_...and ${stale.length - 40} more_` : '')
          )
          .setFooter({ text: preview ? 'Run /link cleanup again without preview to remove them' : 'These members can now re-link with /link set' })
          .setTimestamp()],
      });
    }
  },
};

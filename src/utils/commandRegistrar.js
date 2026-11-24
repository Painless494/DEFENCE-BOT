// ============================================================
// src/utils/commandRegistrar.js
// Automatically registers slash commands with Discord on startup.
// Replaces the need to run `node scripts/deploy-commands.js`.
//
// How it avoids needless API writes:
//   1. Builds the command list from the commands the bot already loaded
//   2. Hashes it and compares with the hash saved from the last
//      successful registration (stored per server in the database)
//   3. If the hash matches AND Discord still has the same command
//      names, it does nothing. Otherwise it re-registers.
//
// Env options (all optional):
//   DISCORD_GUILD_ID          register only in this server
//                             (default: every server the bot is in)
//   FORCE_COMMAND_REGISTER    "true" = always re-register this boot
// ============================================================

const crypto = require('crypto');
const { REST, Routes } = require('discord.js');
const { queryOne, run } = require('./database');
const logger = require('./logger');

function buildPayload(client) {
  return [...client.commands.values()]
    .filter(cmd => cmd.data)
    .map(cmd => cmd.data.toJSON())
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getStoredHash(guildId) {
  const row = queryOne(
    `SELECT setting_value FROM alert_settings
     WHERE guild_id = ? AND alert_type = 'system' AND setting_key = 'commands_hash'`,
    [guildId]
  );
  return row?.setting_value || null;
}

function storeHash(guildId, hash) {
  run(
    `INSERT INTO alert_settings (guild_id, alert_type, setting_key, setting_value)
     VALUES (?, 'system', 'commands_hash', ?)
     ON CONFLICT(guild_id, alert_type, setting_key)
     DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`,
    [guildId, hash]
  );
}

async function registerForGuild(rest, appId, guildId, payload, hash, force) {
  const route = Routes.applicationGuildCommands(appId, guildId);

  if (!force && getStoredHash(guildId) === hash) {
    // Same definitions as last time — confirm Discord still has them
    // (someone could have deleted them manually).
    const remote = await rest.get(route);
    const remoteNames = new Set(remote.map(c => c.name));
    const allPresent  = payload.every(c => remoteNames.has(c.name));
    if (allPresent && remote.length === payload.length) return 'unchanged';
  }

  await rest.put(route, { body: payload });
  storeHash(guildId, hash);
  return 'updated';
}

async function withRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A 400 means Discord rejected the command definitions —
      // retrying won't help, so stop immediately.
      if (err.status === 400) break;
      if (i < attempts) {
        const wait = i * 5000;
        logger.warn(`${label} failed (attempt ${i}/${attempts}): ${err.message} — retrying in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function registerCommands(client) {
  try {
    const payload = buildPayload(client);
    if (payload.length === 0) {
      logger.warn('Command registration skipped — no commands are loaded.');
      return;
    }

    const hash  = hashPayload(payload);
    const force = String(process.env.FORCE_COMMAND_REGISTER || '').toLowerCase() === 'true';
    const appId = client.application?.id || process.env.DISCORD_CLIENT_ID;
    const rest  = new REST().setToken(process.env.DISCORD_TOKEN);

    const guildIds = process.env.DISCORD_GUILD_ID
      ? [process.env.DISCORD_GUILD_ID]
      : [...client.guilds.cache.keys()];

    if (guildIds.length === 0) {
      logger.warn('Command registration skipped — the bot is not in any server yet.');
      return;
    }

    for (const guildId of guildIds) {
      try {
        const result = await withRetry(
          () => registerForGuild(rest, appId, guildId, payload, hash, force),
          `Command registration (guild ${guildId})`
        );
        if (result === 'updated') {
          logger.info(`✅ Slash commands registered automatically: ${payload.length} command(s) in guild ${guildId}`);
        } else {
          logger.info(`Slash commands already up to date in guild ${guildId} (${payload.length} commands)`);
        }
      } catch (err) {
        const detail = err.rawError?.errors ? ` — ${JSON.stringify(err.rawError.errors).slice(0, 600)}` : '';
        logger.error(
          `❌ Automatic command registration failed for guild ${guildId}: ${err.message}${detail}. ` +
          `Existing commands in Discord were left unchanged.`
        );
      }
    }
  } catch (err) {
    // Never let registration problems stop the bot from starting
    logger.error(`Command registrar crashed: ${err.message}`);
  }
}

module.exports = { registerCommands };

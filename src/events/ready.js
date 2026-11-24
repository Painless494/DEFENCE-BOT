// ============================================================
// src/events/ready.js
// Fires ONE TIME when the bot successfully logs into Discord
// ============================================================

const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { startAllJobs } = require('../jobs/scheduler');
const { registerCommands } = require('../utils/commandRegistrar');

module.exports = {
  name: Events.ClientReady,
  once: true, // Only runs once

  async execute(client) {
    logger.info(`✅ Bot is online! Logged in as: ${client.user.tag}`);
    logger.info(`   Serving ${client.guilds.cache.size} server(s)`);

    // Set the bot's status message in Discord
    client.user.setPresence({
      activities: [{ name: '🛡️ Monitoring Alliance' }],
      status: 'online',
    });

    // Register any new/changed slash commands automatically.
    // Safe to fail — errors are logged and never stop the bot.
    await registerCommands(client);

    // Start all background monitoring jobs
    await startAllJobs(client);
    logger.info('✅ Background jobs started');
  },
};

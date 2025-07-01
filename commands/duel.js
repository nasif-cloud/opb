const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder  } = require('discord.js');
const User = require('../db/models/User.js');
const { calculateBattleStats } = require('../utils/battleSystem.js');
const path = require('path');

const DUEL_COOLDOWN = 10 * 60 * 1000; // 10 minutes

function prettyTime(ms) {
  let seconds = Math.floor(ms / 1000);
  let minutes = Math.floor(seconds / 60);
  let hours = Math.floor(minutes / 60);
  minutes = minutes % 60;
  seconds = seconds % 60;
  let out = [];
  if (hours > 0) out.push(`${hours} hour${hours !== 1 ? "s" : ""}`);
  if (minutes > 0) out.push(`${minutes} minute${minutes !== 1 ? "s" : ""}`);
  if (out.length === 0) out.push(`${seconds} second${seconds !== 1 ? "s" : ""}`);
  return out.join(", ");
}

function createHpBar(current, max) {
  const percentage = Math.max(0, current / max);
  const barLength = 10;
  const filledBars = Math.round(percentage * barLength);
  const emptyBars = barLength - filledBars;
  return '█'.repeat(filledBars) + '░'.repeat(emptyBars);
}

function createDuelEmbed(player1, player2, player1Team, player2Team, battleLog, turn, currentPlayerId, winner = null) {
  let description = `**${player1.username}** vs **${player2.username}**\n\n`;

  if (winner) {
    description += `🏆 **${winner.username}** wins the duel!\n\n`;
  } else {
    const currentPlayerName = currentPlayerId === player1.id ? player1.username : player2.username;
    description += `**Turn:** ${turn} | **Current Player:** ${currentPlayerName}\n\n`;
  }

  description += battleLog.slice(-4).join('\n');

  const embed = new EmbedBuilder()
    .setTitle('PvP Duel')
    .setDescription(description)
    .setColor(winner ? 0x2C2F33 : 0x34495E) // dark green if winner, else muted blue-gray
    .setFooter({ text: 'Use the buttons below to take action.' });

  const team1Display = player1Team.filter(card => card.currentHp > 0).map(card => {
    const hpBar = createHpBar(card.currentHp, card.hp);
    return `${card.name} | ${hpBar} | ${card.currentHp}/${card.hp}`;
  }).join('\n') || 'No active cards';

  const team2Display = player2Team.filter(card => card.currentHp > 0).map(card => {
    const hpBar = createHpBar(card.currentHp, card.hp);
    return `${card.name} | ${hpBar} | ${card.currentHp}/${card.hp}`;
  }).join('\n') || 'No active cards';

  embed.addFields(
    { name: `${player1.username}'s Team`, value: team1Display, inline: true },
    { name: `${player2.username}'s Team`, value: team2Display, inline: true }
  );

  return embed;
}

function createDuelButtons(currentPlayerId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('duel_attack')
      .setLabel('Attack')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('duel_defend')
      .setLabel('Defend')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('duel_inventory')
      .setLabel('Items')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('duel_forfeit')
      .setLabel('Forfeit')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

const data = new SlashCommandBuilder()
  .setName('duel')
  .setDescription('Challenge another player to a PvP duel.');

async function execute(message, args) {
  const userId = message.author.id;
  let user = await User.findOne({ userId });

  if (!user) return message.reply('Start your journey with `op start` first!');

  const mentionedUser = message.mentions.users.first();
  if (!mentionedUser) {
    return message.reply('❌ You need to mention a player to duel! Usage: `op duel @player`');
  }

  if (mentionedUser.id === userId) {
    return message.reply('❌ You cannot duel yourself!');
  }

  if (mentionedUser.bot) {
    return message.reply('❌ You cannot duel bots!');
  }

  let opponent = await User.findOne({ userId: mentionedUser.id });
  if (!opponent) {
    return message.reply('❌ That player hasn\'t started their journey yet!');
  }

  // Check if either player is already in a duel
  if (user.battleState.inBattle) {
    return message.reply('❌ You are already in a battle!');
  }

  if (opponent.battleState.inBattle) {
    return message.reply('❌ That player is already in a battle!');
  }

  // Check if both players have teams
  if (!user.team || user.team.length === 0) {
    return message.reply('❌ You need to set up your team first! Use `op team add <card name>`');
  }

  if (!opponent.team || opponent.team.length === 0) {
    return message.reply('❌ Your opponent doesn\'t have a team set up!');
  }

  // Create duel confirmation
  const embed = new EmbedBuilder()
    .setTitle('⚔️ Duel Challenge!')
    .setDescription(`${message.author.username} challenges ${mentionedUser.username} to a duel!\n\n${mentionedUser.username}, do you accept this challenge?`)
    .setColor(0xff6b35);

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('duel_accept')
        .setLabel('Accept Duel')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('duel_decline')
        .setLabel('Decline')
        .setStyle(ButtonStyle.Danger)
    );

  const duelMessage = await message.reply({ embeds: [embed], components: [row] });

  const filter = i => i.user.id === mentionedUser.id && ['duel_accept', 'duel_decline'].includes(i.customId);
  const collector = duelMessage.createMessageComponentCollector({ filter, time: 30000 });

  collector.on('collect', async interaction => {
    try {
      // Check if interaction is still valid
      if (!interaction.isRepliable()) {
        console.log('Duel interaction no longer repliable');
        collector.stop();
        return;
      }

      // Check interaction age
      if (Date.now() - interaction.createdTimestamp > 14 * 60 * 1000) {
        console.log('Duel interaction too old, skipping');
        collector.stop();
        return;
      }

      if (interaction.customId === 'duel_accept') {
        await interaction.deferUpdate();
        
        // Refresh user data to prevent conflicts
        user = await User.findOne({ userId });
        opponent = await User.findOne({ userId: mentionedUser.id });
        
        // Double-check that both players can still duel
        if (user.battleState.inBattle || opponent.battleState.inBattle) {
          return interaction.followUp({ 
            content: 'One of the players is already in battle!', 
            ephemeral: true 
          });
        }
        
        collector.stop(); // Stop collector before starting duel
        await startDuel(message, user, opponent, message.author, mentionedUser, duelMessage);
      } else {
        await interaction.update({
          content: `${mentionedUser.username} declined the duel challenge.`,
          embeds: [],
          components: []
        });
        collector.stop();
      }
    } catch (error) {
      console.error('Duel interaction error:', error);
      // Only try to respond if interaction hasn't been handled
      if (error.code !== 10062 && !interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ 
            content: 'An error occurred while processing the duel request.', 
            ephemeral: true 
          });
        } catch (followUpError) {
          console.log('Could not send error response:', followUpError.message);
        }
      }
      collector.stop();
    }
  });

  collector.on('end', (collected, reason) => {
    if (collected.size === 0 && reason === 'time') {
      duelMessage.edit({
        content: 'Duel challenge expired.',
        embeds: [],
        components: []
      }).catch(() => {});
    }
  });
}

async function startDuel(message, user, opponent, challenger, challenged, duelMessage) {
  // Initialize battle states
  const { calculateCardStats } = require('../utils/levelSystem.js');
  const fs = require('fs');

  // Load cards data
  const cardsPath = path.resolve('data', 'cards.json');
  const allCards = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));

  // Get first cards from teams
  const userCard = user.cards.find(c => c.name === user.team[0]);
  const opponentCard = opponent.cards.find(c => c.name === opponent.team[0]);

  if (!userCard || !opponentCard) {
    return message.reply('❌ Error finding team cards!');
  }

  // Get card definitions
  const userCardDef = allCards.find(c => c.name === userCard.name);
  const opponentCardDef = allCards.find(c => c.name === opponentCard.name);

  // Calculate stats
  const userStats = calculateCardStats(userCardDef, userCard.level || 1);
  const opponentStats = calculateCardStats(opponentCardDef, opponentCard.level || 1);

  // Set battle states
  user.battleState = {
    inBattle: true,
    enemy: {
      name: challenged.username,
      userId: challenged.id,
      card: opponentCard,
      stats: opponentStats,
      hp: opponentStats.health,
      maxHp: opponentStats.health
    },
    battleHp: userStats.health,
    maxBattleHp: userStats.health,
    turnCount: 0,
    battleLog: [],
    isDuel: true,
    currentCard: userCard,
    currentStats: userStats
  };

  opponent.battleState = {
    inBattle: true,
    enemy: {
      name: challenger.username,
      userId: challenger.id,
      card: userCard,
      stats: userStats,
      hp: userStats.health,
      maxHp: userStats.health
    },
    battleHp: opponentStats.health,
    maxBattleHp: opponentStats.health,
    turnCount: 0,
    battleLog: [],
    isDuel: true,
    currentCard: opponentCard,
    currentStats: opponentStats
  };

  await user.save();
  await opponent.save();

  // Set up battle teams for the new system
  const player1Team = [{
    ...userCard,
    currentHp: userStats.health,
    hp: userStats.health,
    attack: userStats.power,
    level: userCard.level || 1
  }];

  const player2Team = [{
    ...opponentCard,
    currentHp: opponentStats.health,
    hp: opponentStats.health,
    attack: opponentStats.power,
    level: opponentCard.level || 1
  }];

  const battleLog = [`${challenger.username}'s ${userCard.name} vs ${challenged.username}'s ${opponentCard.name}!`];

  // Create battle embed using the duel embed function
  const battleEmbed = createDuelEmbed(
    challenger, 
    challenged, 
    player1Team, 
    player2Team, 
    battleLog, 
    1, 
    challenger.id
  );

  const battleRow = createDuelButtons(challenger.id);

  const battleMessage = await duelMessage.edit({ embeds: [battleEmbed], components: [battleRow] });

  // Start battle loop
  await handleDuelBattle(battleMessage, user, opponent, challenger, challenged);
}

async function handleDuelBattle(battleMessage, user, opponent, challenger, challenged) {
  // Set up battle data for the interaction handler
  const { client } = require('../index.js');
  
  if (!client.battles) client.battles = new Map();
  
  const battleData = {
    type: 'duel',
    userId: challenger.id,
    player1: {
      data: challenger,
      user: user,
      team: [user.battleState.currentCard],
      stats: user.battleState.currentStats
    },
    player2: {
      data: challenged,
      user: opponent,
      team: [opponent.battleState.currentCard],
      stats: opponent.battleState.currentStats
    },
    currentPlayer: challenger.id,
    turn: 1,
    battleLog: [`${challenger.username}'s ${user.battleState.currentCard.name} vs ${challenged.username}'s ${opponent.battleState.currentCard.name}!`]
  };
  
  client.battles.set(battleMessage.id, battleData);
  
  // Set up a timeout to clean up the battle
  setTimeout(() => {
    if (client.battles.has(battleMessage.id)) {
      client.battles.delete(battleMessage.id);
    }
  }, 10 * 60 * 1000); // 10 minutes
}

module.exports = { data, execute };
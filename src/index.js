import 'dotenv/config';
import cron from 'node-cron';
import fs from 'fs-extra';
import path from 'path';
import { stringify } from 'csv-stringify';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
} from 'discord.js';
import { db, initDb, getGuildConfig, upsertGuildConfig } from './db.js';
import { parseWindows, splitMinutesByWindows, minutesToCoins } from './time.js';
import { DateTime } from 'luxon';

/* =========================
   Config y cliente
========================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

initDb();

const TZ = process.env.TIMEZONE || 'America/Mexico_City';
const PANEL_GIF_URL = process.env.PANEL_GIF_URL || '';       // Imagen grande (gif) del embed
const PANEL_LOGO_URL = process.env.PANEL_LOGO_URL || '';     // Thumbnail (logo) del embed
const BITACORA_ROLE_IDS = (process.env.BITACORA_ROLE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean); // lista de roles autorizados para 📋 Bitácora

/* =========================
   Ready + loop de pings
========================= */
client.once(Events.ClientReady, async (c) => {
  console.log(`Bot listo como ${c.user.tag}`);
  setInterval(checkSessionsLoop, 60 * 1000); // cada 60s revisa pings/autocierre
});

/* =========================
   Helpers de permisos/panel
========================= */

function userHasBitacoraAccess(interaction) {
  if (!BITACORA_ROLE_IDS.length) return true; // si no se configuró, cualquiera puede usarlo
  if (!interaction.guild) return false;
  const member = interaction.guild.members.cache.get(interaction.user.id);
  if (!member) return false;
  const memberRoleIds = member.roles.cache.map((r) => r.id);
  return BITACORA_ROLE_IDS.some((id) => memberRoleIds.includes(id));
}

// Construye el embed del panel con la lista actualizada de usuarios en servicio
async function buildPanelEmbed(guildId) {
  return new Promise((resolve) => {
    getGuildConfig(guildId, (err, cfg) => {
      const tz = cfg?.timezone || TZ;
      db.all(
        `SELECT user_id FROM sessions WHERE guild_id=? AND status='open'`,
        [guildId],
        (e2, rows) => {
          const tags = rows?.slice(0, 20).map((r) => `<@${r.user_id}>`) || [];
          const extra = rows && rows.length > 20 ? ` +${rows.length - 20} más…` : '';

          const descLines = [
            'Usa los botones para **Entrar/Salir** o **Descanso/Reanudar**.',
            '• Horas estelares diarias: **4–6 PM** y **12–2 AM**',
            `• Zona horaria: **${tz}**`,
            '',
            `**En servicio ahora:** ${tags.length ? tags.join(' ') + extra : '—'}`,
          ];
          const desc = descLines.join('\n') || ' ';

          const embed = new EmbedBuilder()
            .setColor(0xf7a8d8)
            .setTitle('Lollipop Bitácora')
            .setDescription(desc)
            .addFields({
              name: 'Bitácora de Servicio',
              value: 'Tarifa: **1 coin/h normal** · **2 coins/h estelar**',
            });

          if (PANEL_LOGO_URL) embed.setThumbnail(PANEL_LOGO_URL);
          if (PANEL_GIF_URL) embed.setImage(PANEL_GIF_URL);

          resolve(embed);
        }
      );
    });
  });
}

// Busca el mensaje del panel y lo edita; si no existe, publica uno nuevo
async function refreshPanel(guildId) {
  return new Promise((resolve) => {
    getGuildConfig(guildId, async (err, cfg) => {
      if (err || !cfg?.panel_channel_id) return resolve(false);
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return resolve(false);
      const channel = guild.channels.cache.get(cfg.panel_channel_id);
      if (!channel || channel.type !== ChannelType.GuildText) return resolve(false);

      const embed = await buildPanelEmbed(guildId);

      try {
        // intenta encontrar el último panel del bot en los últimos 20 mensajes
        const msgs = await channel.messages.fetch({ limit: 20 });
        const panelMsg = msgs.find(
          (m) =>
            m.author.id === client.user.id &&
            m.embeds?.[0]?.title &&
            /Lollipop Bitácora/i.test(m.embeds[0].title)
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('bitacora_entrar').setLabel('Entrar').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('bitacora_salir').setLabel('Salir').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('bitacora_descanso').setLabel('Descanso').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('bitacora_reanudar').setLabel('Reanudar').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('bitacora_lista').setLabel('📋 Bitácora').setStyle(ButtonStyle.Secondary)
        );

        if (panelMsg) {
          await panelMsg.edit({ embeds: [embed], components: [row] });
          resolve(true);
        } else {
          await channel.send({ embeds: [embed], components: [row] });
          resolve(true);
        }
      } catch {
        resolve(false);
      }
    });
  });
}

/* =========================
   Slash commands
========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'bitacora') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'panel') return handlePanelCmd(interaction);
      if (sub === 'config') return handleConfigCmd(interaction);
      if (sub === 'sumar') return handleAdjustCmd(interaction, true);
      if (sub === 'restar') return handleAdjustCmd(interaction, false);
      if (sub === 'forzar_cierre') return handleForceCloseCmd(interaction);
      if (sub === 'top') return handleTopCmd(interaction);
    } else if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'bitacora_entrar') return handleEntrar(interaction);
      if (id === 'bitacora_salir') return handleSalir(interaction);
      if (id === 'bitacora_descanso') return handleDescanso(interaction);
      if (id === 'bitacora_reanudar') return handleReanudar(interaction);
      if (id === 'bitacora_lista') return handleLista(interaction);
      if (id.startsWith('bitacora_ping_')) return handlePingReply(interaction);
    }
  } catch (e) {
    console.error(e);
    const reply = { content: 'Ocurrió un error. Intenta de nuevo.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

async function handlePanelCmd(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.options.getChannel('canal', true);
  if (channel.type !== ChannelType.GuildText) {
    return interaction.editReply('El canal debe ser de texto.');
  }
  upsertGuildConfig(
    {
      guild_id: interaction.guildId,
      panel_channel_id: channel.id,
      logs_channel_id: null,
      timezone: TZ,
      stellar_windows: '00:00-02:00,16:00-18:00',
      ping_every_min: Number(process.env.PING_EVERY_MIN || 120),
      ping_timeout_min: Number(process.env.PING_TIMEOUT_MIN || 5),
      offline_afk_min: Number(process.env.OFFLINE_AFK_MIN || process.env.OFFLINE_AFk_MIN || 30),
    },
    () => {}
  );
  await refreshPanel(interaction.guildId);
  await interaction.editReply(`Panel publicado/actualizado en ${channel}.`);
}

async function handleConfigCmd(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const canalLogs = interaction.options.getChannel('canal_logs');
  const pingCada = interaction.options.getInteger('ping_cada_min');
  const pingTimeout = interaction.options.getInteger('ping_timeout_min');
  const offlineAfk = interaction.options.getInteger('offline_afk_min');

  getGuildConfig(interaction.guildId, (err, cfg) => {
    if (err) return interaction.editReply('Error cargando config');
    const newCfg = {
      guild_id: interaction.guildId,
      panel_channel_id: cfg?.panel_channel_id || null,
      logs_channel_id: canalLogs?.id || cfg?.logs_channel_id || null,
      timezone: cfg?.timezone || TZ,
      stellar_windows: cfg?.stellar_windows || '00:00-02:00,16:00-18:00',
      ping_every_min: pingCada ?? cfg?.ping_every_min ?? 120,
      ping_timeout_min: pingTimeout ?? cfg?.ping_timeout_min ?? 5,
      offline_afk_min: offlineAfk ?? cfg?.offline_afk_min ?? 30,
    };
    upsertGuildConfig(newCfg, (e2) => {
      if (e2) return interaction.editReply('Error guardando config');
      interaction.editReply('Configuración actualizada ✅');
    });
  });
}

async function handleAdjustCmd(interaction, isAdd) {
  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('usuario', true);
  const minutes = interaction.options.getInteger('minutos', true);
  const reason = interaction.options.getString('motivo', true);
  db.run(
    `INSERT INTO adjustments (guild_id, user_id, minutes, reason, staff_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [interaction.guildId, user.id, isAdd ? minutes : -minutes, reason, interaction.user.id, Date.now()],
    (err) => {
      if (err) return interaction.editReply('Error guardando ajuste');
      interaction.editReply(`${isAdd ? 'Sumados' : 'Restados'} ${Math.abs(minutes)} minutos a ${user}. Motivo: ${reason}`);
    }
  );
}

async function handleForceCloseCmd(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const user = interaction.options.getUser('usuario', true);
  db.get(
    `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status='open'`,
    [interaction.guildId, user.id],
    (err, row) => {
      if (err) return interaction.editReply('Error en DB');
      if (!row) return interaction.editReply('El usuario no tiene una sesión abierta.');
      closeSession(interaction.guildId, user.id, row.id, 'Forzado por staff', async (e2, summary) => {
        if (e2) return interaction.editReply('Error cerrando sesión');
        await refreshPanel(interaction.guildId);
        interaction.editReply(`Sesión forzada a cierre. Resumen: ${summary}`);
      });
    }
  );
}

async function handleTopCmd(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const periodo = interaction.options.getString('periodo', true);
  const now = DateTime.now().setZone(TZ);
  let from;
  if (periodo === 'hoy') from = now.startOf('day').toMillis();
  else if (periodo === 'semana') from = now.startOf('week').toMillis();
  else if (periodo === 'mes') from = now.startOf('month').toMillis();
  else return interaction.editReply('Periodo inválido: usa hoy|semana|mes');

  db.all(
    `SELECT user_id, SUM(min_normales) AS n, SUM(min_estelares) AS e
     FROM sessions WHERE guild_id=? AND status='closed' AND end_at>=?
     GROUP BY user_id
     ORDER BY ( (n/60.0)*1 + (e/60.0)*2 ) DESC
     LIMIT 15`,
    [interaction.guildId, from],
    async (err, rows) => {
      if (err) return interaction.editReply('Error DB');
      const lines =
        rows?.map((r, i) => {
          const coins = ((r.n / 60) * 1 + (r.e / 60) * 2).toFixed(2);
          const hn = (r.n / 60).toFixed(2);
          const he = (r.e / 60).toFixed(2);
          return `**${i + 1}.** <@${r.user_id}> — Normales: ${hn}h · Estelares: ${he}h · **${coins} coins**`;
        }) || ['—'];
      const embed = new EmbedBuilder().setColor(0xf7a8d8).setTitle(`🏆 Top ${periodo}`).setDescription(lines.join('\n') || ' ');
      interaction.editReply({ embeds: [embed] });
    }
  );
}

/* =========================
   Botones (con deferReply)
========================= */

async function handleEntrar(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  db.get(
    `SELECT id FROM sessions WHERE guild_id=? AND user_id=? AND status='open'`,
    [guildId, userId],
    async (err, row) => {
      if (row) return interaction.editReply('Ya tienes una sesión abierta.');
      db.run(
        `INSERT INTO sessions (guild_id, user_id, status, start_at, last_action_at)
         VALUES (?, ?, 'open', ?, ?)`,
        [guildId, userId, Date.now(), Date.now()],
        async (e2) => {
          if (e2) return interaction.editReply('Error abriendo sesión');
          await refreshPanel(guildId);
          interaction.editReply('Has iniciado tu bitácora — ¡buen servicio! 🩷');
        }
      );
    }
  );
}

async function handleDescanso(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  db.get(
    `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status='open'`,
    [guildId, userId],
    (err, row) => {
      if (!row) return interaction.editReply('No tienes sesión activa.');
      db.run(`INSERT INTO pauses (session_id, pause_start) VALUES (?, ?)`, [row.id, Date.now()], async (e2) => {
        if (e2) return interaction.editReply('Error al pausar');
        db.run(`UPDATE sessions SET status='paused', last_action_at=? WHERE id=?`, [Date.now(), row.id]);
        await refreshPanel(guildId);
        interaction.editReply('Bitácora en pausa ⏸️');
      });
    }
  );
}

async function handleReanudar(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  db.get(
    `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status='paused'`,
    [guildId, userId],
    (err, row) => {
      if (!row) return interaction.editReply('No tienes una pausa activa.');
      db.get(
        `SELECT * FROM pauses WHERE session_id=? AND pause_end IS NULL ORDER BY id DESC LIMIT 1`,
        [row.id],
        (e2, pr) => {
          if (!pr) return interaction.editReply('No hay pausa abierta para cerrar.');
          db.run(`UPDATE pauses SET pause_end=? WHERE id=?`, [Date.now(), pr.id], async (e3) => {
            if (e3) return interaction.editReply('Error reanudando');
            db.run(`UPDATE sessions SET status='open', last_action_at=? WHERE id=?`, [Date.now(), row.id]);
            await refreshPanel(guildId);
            interaction.editReply('Bitácora reanudada ▶️');
          });
        }
      );
    }
  );
}

async function handleSalir(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  db.get(
    `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND (status='open' OR status='paused')`,
    [guildId, userId],
    (err, row) => {
      if (!row) return interaction.editReply('No tienes una sesión para cerrar.');
      closeSession(guildId, userId, row.id, 'Cierre voluntario', async (e2, summary) => {
        if (e2) return interaction.editReply('Error cerrando sesión');
        await refreshPanel(guildId);
        interaction.editReply(summary);
      });
    }
  );
}

async function handleLista(interaction) {
  // Permiso por rol para usar 📋 Bitácora
  if (!userHasBitacoraAccess(interaction)) {
    return interaction.reply({ content: 'No tienes permiso para usar 📋 Bitácora.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: false });
  const now = DateTime.now().setZone(TZ);
  const from = now.startOf('day').toMillis();
  db.all(
    `SELECT user_id, SUM(min_normales) AS n, SUM(min_estelares) AS e
     FROM sessions WHERE guild_id=? AND status='closed' AND end_at>=?
     GROUP BY user_id
     ORDER BY ( (n/60.0)*1 + (e/60.0)*2 ) DESC
     LIMIT 15`,
    [interaction.guildId, from],
    (err, rows) => {
      const lines =
        rows?.map((r, i) => {
          const coins = ((r.n / 60) * 1 + (r.e / 60) * 2).toFixed(2);
          return `**${i + 1}.** <@${r.user_id}> — ${coins} coins (Normales ${(r.n / 60).toFixed(2)}h · Estelares ${(r.e / 60).toFixed(2)}h)`;
        }) || ['—'];
      const embed = new EmbedBuilder()
        .setColor(0xf7a8d8)
        .setTitle('📋 Bitácora — Hoy')
        .setDescription(lines.join('\n') || ' ');
      interaction.editReply({ embeds: [embed] });
    }
  );
}

/* =========================
   Cálculo de tiempos y cierre
========================= */

function computeWorkedSplit(sess, cfg, callback) {
  const tz = cfg?.timezone || TZ;
  const windows = parseWindows(cfg?.stellar_windows || '00:00-02:00,16:00-18:00');
  const endAt = Date.now();

  db.all(`SELECT * FROM pauses WHERE session_id=?`, [sess.id], (err, pauses) => {
    if (err) return callback(err);
    const intervals = [];
    let cursor = sess.start_at;
    const sorted = (pauses || []).sort((a, b) => (a.pause_start || 0) - (b.pause_start || 0));

    for (const p of sorted) {
      const ps = p.pause_start;
      const pe = p.pause_end ?? endAt;
      if (ps > cursor) intervals.push([cursor, Math.min(ps, endAt)]);
      cursor = Math.max(cursor, pe);
    }
    if (cursor < endAt) intervals.push([cursor, endAt]);

    let normales = 0,
      estelares = 0;
    for (const [a, b] of intervals) {
      const s = splitMinutesByWindows(a, b, tz, windows);
      normales += s.normales;
      estelares += s.estelares;
    }
    callback(null, { normales, estelares, intervals });
  });
}

function closeSession(guildId, userId, sessionId, reason, cb) {
  getGuildConfig(guildId, (err, cfg) => {
    if (err) return cb(err);
    db.get(`SELECT * FROM sessions WHERE id=?`, [sessionId], (e2, sess) => {
      if (e2 || !sess) return cb(e2 || new Error('No session'));
      db.get(`SELECT * FROM pauses WHERE session_id=? AND pause_end IS NULL`, [sessionId], (e3, pr) => {
        const proceed = () => {
          computeWorkedSplit(sess, cfg, (e4, split) => {
            if (e4) return cb(e4);
            const endAt = Date.now();
            db.run(
              `UPDATE sessions
               SET status='closed', end_at=?, min_normales=?, min_estelares=?, last_action_at=?
               WHERE id=?`,
              [endAt, split.normales, split.estelares, Date.now(), sessionId],
              (e5) => {
                if (e5) return cb(e5);
                const coins = minutesToCoins(split.normales, split.estelares).toFixed(2);
                const hn = (split.normales / 60).toFixed(2);
                const he = (split.estelares / 60).toFixed(2);
                const summary = `Resumen de sesión — Normales: ${hn}h · Estelares: ${he}h → **${coins} coins**`;

                if (cfg?.logs_channel_id) {
                  const ch = client.channels.cache.get(cfg.logs_channel_id);
                  if (ch) ch.send(`🔔 **Cierre de bitácora:** <@${userId}> — ${summary} (${reason})`);
                }
                cb(null, summary);
              }
            );
          });
        };
        if (pr) db.run(`UPDATE pauses SET pause_end=? WHERE id=?`, [Date.now(), pr.id], () => proceed());
        else proceed();
      });
    });
  });
}

/* =========================
   Pings por DM + autocierre
========================= */

// Deshabilita los botones del mensaje de ping para evitar spam
async function disablePingButtons(message) {
  try {
    if (!message?.components?.length) return;
    const disabledRows = message.components.map((row) => {
      const newRow = new ActionRowBuilder();
      newRow.addComponents(...row.components.map((c) => ButtonBuilder.from(c).setDisabled(true)));
      return newRow;
    });
    await message.edit({ components: disabledRows });
  } catch {
    // ignore
  }
}

async function checkSessionsLoop() {
  client.guilds.cache.forEach((guild) => {
    getGuildConfig(guild.id, async (err, cfg) => {
      if (err || !cfg) return;
      const now = Date.now();
      const every = (cfg.ping_every_min || 120) * 60 * 1000;

      db.all(
        `SELECT * FROM sessions WHERE guild_id=? AND (status='open' OR status='paused')`,
        [guild.id],
        async (e2, rows) => {
          if (e2) return;
          for (const s of rows || []) {
            // ¿toca ping?
            if (!s.last_ping_at || now - s.last_ping_at >= every) {
              try {
                const member = await guild.members.fetch(s.user_id).catch(() => null);
                let sent = false;
                if (member) {
                  // intentamos DM (privado)
                  try {
                    const dm = await member.createDM();
                    const row = new ActionRowBuilder().addComponents(
                      new ButtonBuilder()
                        .setCustomId(`bitacora_ping_yes_${s.id}`)
                        .setLabel('Sí, sigo en servicio')
                        .setStyle(ButtonStyle.Success),
                      new ButtonBuilder()
                        .setCustomId(`bitacora_ping_close_${s.id}`)
                        .setLabel('Cerrar ahora')
                        .setStyle(ButtonStyle.Danger)
                    );
                    await dm.send({ content: `¿Sigues en servicio en **${guild.name}**?`, components: [row] });
                    sent = true;
                  } catch {
                    sent = false;
                  }
                }
                // fallback público si DM no se pudo (no puede ser efímero)
                if (!sent && cfg.panel_channel_id) {
                  const ch = guild.channels.cache.get(cfg.panel_channel_id);
                  if (ch) {
                    const row = new ActionRowBuilder().addComponents(
                      new ButtonBuilder()
                        .setCustomId(`bitacora_ping_yes_${s.id}`)
                        .setLabel('Sí, sigo en servicio')
                        .setStyle(ButtonStyle.Success),
                      new ButtonBuilder()
                        .setCustomId(`bitacora_ping_close_${s.id}`)
                        .setLabel('Cerrar ahora')
                        .setStyle(ButtonStyle.Danger)
                    );
                    await ch.send({ content: `<@${s.user_id}> ¿Sigues en servicio?`, components: [row] });
                  }
                }
                db.run(`UPDATE sessions SET last_ping_at=?, pending_ping=1 WHERE id=?`, [now, s.id]);
              } catch {
                // ignore
              }
            } else if (s.pending_ping && now - s.last_ping_at >= (cfg.ping_timeout_min || 5) * 60 * 1000) {
              closeSession(guild.id, s.user_id, s.id, 'Autocierre por no responder', async () => {
                db.run(`UPDATE sessions SET pending_ping=0 WHERE id=?`, [s.id]);
                await refreshPanel(guild.id);
              });
            }
          }
        }
      );
    });
  });
}

async function handlePingReply(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const [, , action, sessionIdStr] = interaction.customId.split('_'); // bitacora_ping_yes_<id> | ..._close_<id>
  const sessionId = Number(sessionIdStr);
  const pingMessage = interaction.message; // el mensaje que contiene los botones

  db.get(`SELECT * FROM sessions WHERE id=?`, [sessionId], async (err, s) => {
    if (!s) {
      await disablePingButtons(pingMessage);
      return interaction.editReply('Sesión no encontrada.');
    }
    if (s.user_id !== interaction.user.id) {
      await disablePingButtons(pingMessage);
      return interaction.editReply('Este ping no es para ti 😊');
    }

    // Deshabilita los botones del mensaje de notificación para evitar spam
    await disablePingButtons(pingMessage);

    if (action === 'yes') {
      db.run(`UPDATE sessions SET pending_ping=0 WHERE id=?`, [sessionId]);
      return interaction.editReply('¡Perfecto! Seguimos contando tu servicio 💪');
    } else if (action === 'close') {
      // usar el guild_id de la sesión (en DMs interaction.guildId puede ser null)
      closeSession(s.guild_id, interaction.user.id, sessionId, 'Cierre por usuario en ping', async (e2, summary) => {
        if (e2) return interaction.editReply('Error cerrando sesión');
        await refreshPanel(s.guild_id);
        interaction.editReply(summary);
      });
    }
  });
}

/* =========================
   Backups semanales (CSV) + reset semanal
========================= */

const BACKUP_DIR = path.resolve('./backups');
fs.ensureDirSync(BACKUP_DIR);

// Exporta CSV de todas las sesiones y hace archivo-adjuntado + archivado/limpieza
async function resetWeeklyBitacora(guildId) {
  return new Promise((resolve) => {
    getGuildConfig(guildId, async (err, cfg) => {
      if (err || !cfg) return resolve();
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return resolve();

      const serverName = guild.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const dateStr = DateTime.now().setZone(TZ).toFormat('yyyy-LL-dd');

      // Obtener todas las sesiones (cerradas o abiertas)
      db.all(`SELECT * FROM sessions WHERE guild_id=?`, [guildId], async (e2, rows) => {
        if (e2) return resolve();

        // Preparar CSV
        const fileName = `bitacora_${serverName}_${dateStr}.csv`;
        const fullPath = path.join(BACKUP_DIR, fileName);
        const columns = [
          'session_id',
          'user_id',
          'start_at',
          'end_at',
          'min_normales',
          'min_estelares',
          'reason',
          'coins',
        ];
        const stringifier = stringify({ header: true, columns });
        const writable = fs.createWriteStream(fullPath);
        stringifier.pipe(writable);

        for (const r of rows) {
          const coins = ((r.min_normales / 60) * 1 + (r.min_estelares / 60) * 2).toFixed(2);
          stringifier.write({
            session_id: r.id,
            user_id: r.user_id,
            start_at: r.start_at,
            end_at: r.end_at || '',
            min_normales: r.min_normales || 0,
            min_estelares: r.min_estelares || 0,
            reason: r.status === 'closed' ? r.reason : 'Auto-reset semanal',
            coins,
          });
        }
        stringifier.end();

        writable.on('finish', async () => {
          // Enviar al canal de logs
          if (cfg.logs_channel_id) {
            const ch = guild.channels.cache.get(cfg.logs_channel_id);
            if (ch) {
              await ch.send({
                content: `📦 Respaldo semanal generado: **${fileName}**`,
                files: [fullPath],
              });
            }
          }

          // Archivar: mover a history
          db.run(
            `INSERT INTO sessions_history SELECT *, ? AS archived_at FROM sessions WHERE guild_id=?`,
            [Date.now(), guildId],
            (e3) => {
              if (e3) console.error('Error archivando sesiones:', e3);
              // Limpiar tabla de sesiones para nueva semana
              db.run(`DELETE FROM sessions WHERE guild_id=?`, [guildId], (e4) => {
                if (e4) console.error('Error limpiando sesiones:', e4);
                // Limpiar orfandas de pauses
                db.run(
                  `DELETE FROM pauses WHERE session_id NOT IN (SELECT id FROM sessions)`,
                  async (e5) => {
                    if (e5) console.error('Error limpiando pauses:', e5);
                    await refreshPanel(guildId);
                    resolve();
                  }
                );
              });
            }
          );
        });
      });
    });
  });
}

// Programar cron para cada viernes 17:00 CDMX
cron.schedule(
  '0 17 * * 5',
  async () => {
    console.log('Ejecutando reset semanal de bitácora...');
    for (const guild of client.guilds.cache.values()) {
      await resetWeeklyBitacora(guild.id);
    }
  },
  { timezone: 'America/Mexico_City' }
);

/* =========================
   Login
========================= */
client.login(process.env.DISCORD_TOKEN);

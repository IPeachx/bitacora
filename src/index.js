// src/index.js
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, Events, SlashCommandBuilder
} from 'discord.js';
import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- RUTA DB ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultDbPath = path.join(__dirname, '..', 'bitacora.db');
const DB_PATH = process.env.DB_PATH || defaultDbPath;

// ---------- ZONA HORARIA ----------
const TZ = process.env.TIMEZONE || 'America/Mexico_City';

// ---------- CLIENTE ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

// ---------- DB & TABLAS ----------
sqlite3.verbose();
export const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS guild_config(
    guild_id TEXT PRIMARY KEY,
    panel_channel_id TEXT,
    panel_message_id TEXT,
    timezone TEXT,
    panel_gif_url TEXT,
    panel_logo_url TEXT,
    bitacora_role_ids TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    start_at INTEGER,
    end_at INTEGER,
    status TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pauses(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER,
    pause_start INTEGER,
    pause_end INTEGER
  )`);
});

// --- MIGRACIÓN DE ESQUEMA: añade columnas faltantes en guild_config ---
function ensureGuildConfigColumns() {
  return new Promise((resolve) => {
    db.all(`PRAGMA table_info('guild_config')`, [], (e, rows = []) => {
      if (e) return resolve();
      const cols = new Set(rows.map(r => r.name));

      const addIfMissing = (name, type = 'TEXT') => new Promise(r =>
        cols.has(name)
          ? r()
          : db.run(`ALTER TABLE guild_config ADD COLUMN ${name} ${type}`, [], () => r())
      );

      Promise.resolve()
        .then(() => addIfMissing('panel_channel_id', 'TEXT'))
        .then(() => addIfMissing('panel_message_id', 'TEXT'))
        .then(() => addIfMissing('timezone', 'TEXT'))
        .then(() => addIfMissing('panel_gif_url', 'TEXT'))
        .then(() => addIfMissing('panel_logo_url', 'TEXT'))
        .then(() => addIfMissing('bitacora_role_ids', 'TEXT'))
        .then(() => resolve());
    });
  });
}

// Llama a la migración en el arranque:
ensureGuildConfigColumns().then(() => {
  console.log('Esquema guild_config verificado/migrado');
}).catch(() => {});


// ---------- HELPERS CONFIG ----------
function getGuildConfig(guildId) {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM guild_config WHERE guild_id=?`, [guildId], (e, row) => {
      if (e) return resolve(null);
      resolve(row || null);
    });
  });
}

function upsertGuildConfig(cfg) {
  return new Promise((resolve, reject) => {
    const fields = [
      'panel_channel_id', 'panel_message_id', 'timezone',
      'panel_gif_url', 'panel_logo_url', 'bitacora_role_ids'
    ];
    getGuildConfig(cfg.guild_id).then((row) => {
      const existing = row || {};
      const merged = { ...existing, ...cfg };
      db.run(
        `INSERT INTO guild_config(guild_id, panel_channel_id, panel_message_id, timezone, panel_gif_url, panel_logo_url, bitacora_role_ids)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(guild_id) DO UPDATE SET
           panel_channel_id=excluded.panel_channel_id,
           panel_message_id=excluded.panel_message_id,
           timezone=excluded.timezone,
           panel_gif_url=excluded.panel_gif_url,
           panel_logo_url=excluded.panel_logo_url,
           bitacora_role_ids=excluded.bitacora_role_ids`,
        [
          cfg.guild_id,
          merged.panel_channel_id || null,
          merged.panel_message_id || null,
          merged.timezone || TZ,
          merged.panel_gif_url || null,
          merged.panel_logo_url || null,
          merged.bitacora_role_ids || null
        ],
        (e) => (e ? reject(e) : resolve())
      );
    });
  });
}

// ---------- HELPERS SESSIONS ----------
async function getOpenUserIds(guildId) {
  return await new Promise((res) =>
    db.all(
      `SELECT user_id FROM sessions WHERE guild_id=? AND status='open'`,
      [guildId],
      (e, rows = []) => res(rows.map(r => r.user_id))
    )
  );
}

function getOpenSession(guildId, userId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status='open'`,
      [guildId, userId],
      (e, row) => resolve(row || null)
    );
  });
}

async function startSession(guildId, userId) {
  const open = await getOpenSession(guildId, userId);
  if (open) return open.id;
  return await new Promise((resolve) => {
    db.run(
      `INSERT INTO sessions(guild_id, user_id, start_at, status) VALUES(?,?,?, 'open')`,
      [guildId, userId, Date.now()],
      function () { resolve(this.lastID); }
    );
  });
}

async function endSession(guildId, userId) {
  const open = await getOpenSession(guildId, userId);
  if (!open) return false;
  return await new Promise((resolve) => {
    db.run(
      `UPDATE sessions SET end_at=?, status='closed' WHERE id=?`,
      [Date.now(), open.id],
      () => resolve(true)
    );
  });
}

async function pauseSession(guildId, userId) {
  const open = await getOpenSession(guildId, userId);
  if (!open) return false;
  // si ya hay pausa abierta, no hagas nada
  const paused = await new Promise((res) =>
    db.get(
      `SELECT * FROM pauses WHERE session_id=? AND pause_end IS NULL`,
      [open.id],
      (e, row) => res(row || null)
    )
  );
  if (paused) return true;
  return await new Promise((resolve) => {
    db.run(
      `INSERT INTO pauses(session_id, pause_start) VALUES(?,?)`,
      [open.id, Date.now()],
      () => resolve(true)
    );
  });
}

async function resumeSession(guildId, userId) {
  const open = await getOpenSession(guildId, userId);
  if (!open) return false;
  return await new Promise((resolve) => {
    db.run(
      `UPDATE pauses SET pause_end=? WHERE session_id=? AND pause_end IS NULL`,
      [Date.now(), open.id],
      () => resolve(true)
    );
  });
}

// ---------- PANEL (embed + botones) ----------
function buildPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bitacora_enter').setLabel('Entrar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bitacora_exit').setLabel('Salir').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('bitacora_pause').setLabel('Descanso').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bitacora_resume').setLabel('Reanudar').setStyle(ButtonStyle.Primary)
  );
}

function buildPanelEmbedFromOpen(openUserIds, cfg) {
  const tags = (openUserIds && openUserIds.length)
    ? openUserIds.map(id => `<@${id}>`).join(' ')
    : '—';

  const embed = new EmbedBuilder()
    .setTitle('Lollipop Bitácora')
    .setDescription([
      '**Bitácora de Servicio**',
      'Usa los botones para **Entrar/Salir** o **Descanso/Reanudar**.',
      '• Horas estelares diarias: **4–6 PM y 12–2 AM**',
      `• Zona horaria: **${cfg.timezone || TZ}**`,
      '',
      `**En servicio ahora:** ${tags}`,
      '',
      '*Tarifa:* 1 coin/h normal · 2 coins/h estelar'
    ].join('\n'))
    .setColor(0xff66cc);

  if (cfg.panel_gif_url) embed.setImage(cfg.panel_gif_url);
  if (cfg.panel_logo_url) embed.setThumbnail(cfg.panel_logo_url);
  return embed;
}

/**
 * Publica/edita/adopta SIEMPRE un solo panel.
 * - Si hay message_id válido: edita.
 * - Si no, busca uno del bot en el canal y lo adopta.
 * - Si no existe, publica nuevo y guarda el ID.
 */
async function publishOrEditPanel(guildId, forceChannelId = null) {
  const raw = await getGuildConfig(guildId);
  const cfg = raw || { guild_id: guildId, timezone: TZ };

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const channelId = forceChannelId || cfg.panel_channel_id;
  if (!channelId) return;

  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;

  const openIds = await getOpenUserIds(guildId);
  const embed = buildPanelEmbedFromOpen(openIds, cfg);
  const row = buildPanelButtons();

  // 1) Editar por message_id guardado
  if (cfg.panel_message_id) {
    const msg = await ch.messages.fetch(cfg.panel_message_id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
      return;
    }
  }

  // 2) Adoptar panel existente del bot en el canal
  const recent = await ch.messages.fetch({ limit: 30 }).catch(() => null);
  if (recent) {
    const mine = recent.find(m =>
      m.author?.id === client.user.id &&
      m.embeds?.[0]?.title === 'Lollipop Bitácora'
    );
    if (mine) {
      await upsertGuildConfig({
        guild_id: guildId,
        panel_channel_id: ch.id,
        panel_message_id: mine.id
      });
      await mine.edit({ embeds: [embed], components: [row] }).catch(() => {});
      return;
    }
  }

  // 3) Publicar nuevo
  const newMsg = await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
  if (newMsg) {
    await upsertGuildConfig({
      guild_id: guildId,
      panel_channel_id: ch.id,
      panel_message_id: newMsg.id
    });
  }
}

// ---------- PERMISOS PARA /bitacora panel/refresh ----------
async function userHasBitacoraAccess(interaction) {
  // Si definiste roles permitidos en env o config, valida aquí.
  const cfg = await getGuildConfig(interaction.guildId);
  const allowed = cfg?.bitacora_role_ids
    ? cfg.bitacora_role_ids.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  if (!allowed.length) return true; // si no configuraste roles, deja usarlo

  const member = await interaction.guild.members.fetch(interaction.user.id);
  return member.roles.cache.some(r => allowed.includes(r.id));
}

// ---------- READY ----------
client.once(Events.ClientReady, async () => {
  console.log(`Bot listo como ${client.user.tag}`);
  // Opcional: refresca paneles de todos los servers donde estés
  client.guilds.cache.forEach(async (g) => {
    const cfg = await getGuildConfig(g.id);
    if (cfg?.panel_channel_id) {
      await publishOrEditPanel(g.id).catch(() => {});
    }
  });
});

// ---------- INTERACTIONS ----------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'bitacora') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'panel') {
          if (!(await userHasBitacoraAccess(interaction))) {
            return interaction.reply({ content: 'No tienes permisos para usar este comando.', ephemeral: true });
          }
          const ch = interaction.options.getChannel('canal', true);
          if (ch.type !== ChannelType.GuildText) {
            return interaction.reply({ content: 'El canal debe ser de texto.', ephemeral: true });
          }
          await upsertGuildConfig({ guild_id: interaction.guildId, panel_channel_id: ch.id });
          await publishOrEditPanel(interaction.guildId, ch.id);
          return interaction.reply({ content: 'Panel publicado/actualizado ✅', ephemeral: true });
        }

        if (sub === 'refresh') {
          const chOpt = interaction.options.getChannel('canal', false);
          const chId = chOpt?.id || null;
          await publishOrEditPanel(interaction.guildId, chId);
          return interaction.reply({ content: 'Panel refrescado ✅', ephemeral: true });
        }

        return interaction.reply({ content: 'Comando no reconocido.', ephemeral: true });
      }
    }

    // Botones
    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id === 'bitacora_enter') {
        await startSession(interaction.guildId, interaction.user.id);
        await publishOrEditPanel(interaction.guildId);
        return interaction.reply({ content: 'Has iniciado tu bitácora — ¡buen servicio! 💖', ephemeral: true });
      }

      if (id === 'bitacora_exit') {
        await endSession(interaction.guildId, interaction.user.id);
        await publishOrEditPanel(interaction.guildId);
        return interaction.reply({ content: 'Bitácora cerrada. ¡Gracias! ✅', ephemeral: true });
      }

      if (id === 'bitacora_pause') {
        await pauseSession(interaction.guildId, interaction.user.id);
        await publishOrEditPanel(interaction.guildId);
        return interaction.reply({ content: 'Pausa iniciada. ⏸️', ephemeral: true });
      }

      if (id === 'bitacora_resume') {
        await resumeSession(interaction.guildId, interaction.user.id);
        await publishOrEditPanel(interaction.guildId);
        return interaction.reply({ content: 'Seguimos contando tu servicio. ▶️', ephemeral: true });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: 'Hubo un error. Inténtalo de nuevo.', ephemeral: true }); } catch {}
    }
  }
});

// ---------- LOGIN ----------
client.login(process.env.DISCORD_TOKEN);

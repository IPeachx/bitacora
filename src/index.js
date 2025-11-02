// src/index.js
import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import sqlite3 from 'sqlite3';
import { DateTime, Interval } from 'luxon';
import cron from 'node-cron';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import { stringify } from 'csv-stringify';

// ------------------------------
// Rutas / Constantes
// ------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TZ = process.env.TIMEZONE || 'America/Mexico_City';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bitacora.db');
const BITACORA_ROLE_IDS = (process.env.BITACORA_ROLE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const PING_EVERY_MIN = parseInt(process.env.PING_EVERY_MIN || '120', 10);
const PING_TIMEOUT_MIN = parseInt(process.env.PING_TIMEOUT_MIN || '5', 10);
const NIGHTLY_UPLOAD = String(process.env.NIGHTLY_BACKUP_UPLOAD || 'false').toLowerCase() === 'true';

const DATA_DIR = path.join(__dirname, '..');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
await fs.ensureDir(BACKUP_DIR);

// ------------------------------
// DB
// ------------------------------
sqlite3.verbose();
const db = new sqlite3.Database(DB_PATH);

function initDb() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      panel_channel_id TEXT,
      panel_message_id TEXT,
      logs_channel_id  TEXT,
      timezone         TEXT,
      stellar_windows  TEXT,
      ping_every_min   INTEGER,
      ping_timeout_min INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      status        TEXT NOT NULL,
      start_at      INTEGER NOT NULL,
      end_at        INTEGER,
      min_normales  INTEGER DEFAULT 0,
      min_estelares INTEGER DEFAULT 0,
      last_ping_at  INTEGER,
      pending_ping  INTEGER DEFAULT 0,
      reason        TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS pauses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      pause_start INTEGER NOT NULL,
      pause_end   INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS adjustments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      minutes    INTEGER NOT NULL,
      reason     TEXT,
      staff_id   TEXT,
      created_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions_history (
      id            INTEGER,
      guild_id      TEXT,
      user_id       TEXT,
      status        TEXT,
      start_at      INTEGER,
      end_at        INTEGER,
      min_normales  INTEGER,
      min_estelares INTEGER,
      last_ping_at  INTEGER,
      pending_ping  INTEGER,
      reason        TEXT,
      archived_at   INTEGER
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_guild_user ON sessions(guild_id, user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_guild_status ON sessions(guild_id, status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pauses_session ON pauses(session_id)`);
  });
}

function getGuildConfig(guildId) {
  return new Promise(res => {
    db.get(`SELECT * FROM guild_config WHERE guild_id=?`, [guildId], (e, row) => res(row || null));
  });
}

function upsertGuildConfig(cfg) {
  return new Promise(res => {
    db.get(`SELECT guild_id FROM guild_config WHERE guild_id=?`, [cfg.guild_id], (e, row) => {
      const data = {
        panel_channel_id: cfg.panel_channel_id ?? null,
        panel_message_id: cfg.panel_message_id ?? null,
        logs_channel_id: cfg.logs_channel_id ?? null,
        timezone: cfg.timezone || TZ,
        stellar_windows: cfg.stellar_windows || '00:00-02:00,16:00-18:00',
        ping_every_min: cfg.ping_every_min ?? PING_EVERY_MIN,
        ping_timeout_min: cfg.ping_timeout_min ?? PING_TIMEOUT_MIN,
      };
      if (row) {
        db.run(
          `UPDATE guild_config SET
            panel_channel_id=?, panel_message_id=?, logs_channel_id=?,
            timezone=?, stellar_windows=?, ping_every_min=?, ping_timeout_min=?
           WHERE guild_id=?`,
          [
            data.panel_channel_id, data.panel_message_id, data.logs_channel_id,
            data.timezone, data.stellar_windows, data.ping_every_min, data.ping_timeout_min,
            cfg.guild_id,
          ],
          () => res()
        );
      } else {
        db.run(
          `INSERT INTO guild_config
           (guild_id, panel_channel_id, panel_message_id, logs_channel_id, timezone, stellar_windows, ping_every_min, ping_timeout_min)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            cfg.guild_id, data.panel_channel_id, data.panel_message_id, data.logs_channel_id,
            data.timezone, data.stellar_windows, data.ping_every_min, data.ping_timeout_min,
          ],
          () => res()
        );
      }
    });
  });
}

// ------------------------------
// Time helpers
// ------------------------------
function parseWindows(spec = '00:00-02:00,16:00-18:00') {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map(p => {
    const [a, b] = p.split('-').map(s => s.trim());
    return { from: a, to: b };
  });
}

function splitMinutesByWindows(fromMs, toMs, timezone, windows) {
  let normales = 0;
  let estelares = 0;

  let cursor = DateTime.fromMillis(fromMs).setZone(timezone);
  const end = DateTime.fromMillis(toMs).setZone(timezone);

  while (cursor < end) {
    const next = cursor.plus({ minutes: 1 });
    const hhmm = cursor.toFormat('HH:mm');
    const inStellar = windows.some(w => {
      const s = DateTime.fromFormat(w.from, 'HH:mm', { zone: timezone });
      const e = DateTime.fromFormat(w.to, 'HH:mm', { zone: timezone });
      return Interval.fromDateTimes(s, e).contains(DateTime.fromFormat(hhmm, 'HH:mm', { zone: timezone }));
    });
    if (inStellar) estelares += 1; else normales += 1;
    cursor = next;
  }
  return { normales, estelares };
}

function minutesMinusPauses(start, end, pauses) {
  const total = Math.max(0, Math.floor((end - start) / 60000));
  if (!pauses?.length) return total;
  let paused = 0;
  for (const p of pauses) {
    const ps = Math.max(start, p.pause_start);
    const pe = Math.min(end, p.pause_end ?? end);
    if (pe > ps) paused += Math.floor((pe - ps) / 60000);
  }
  return Math.max(0, total - paused);
}

function formatH(mins) {
  return (mins / 60).toFixed(2) + 'h';
}

function getPeriodRange(period, timezone) {
  const now = DateTime.now().setZone(timezone);
  if (period === 'hoy') {
    const from = now.startOf('day'); const to = now;
    return { from: from.toMillis(), to: to.toMillis() };
  }
  if (period === 'semana') {
    const from = now.startOf('week'); const to = now;
    return { from: from.toMillis(), to: to.toMillis() };
  }
  if (period === 'mes') {
    const from = now.startOf('month'); const to = now;
    return { from: from.toMillis(), to: to.toMillis() };
  }
  return null;
}

// ------------------------------
// Discord client (incluye DMs para pings)
// ------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ------------------------------
// Permisos por rol (si configuras BITACORA_ROLE_IDS)
// ------------------------------
async function userHasBitacoraAccess(interaction) {
  if (!BITACORA_ROLE_IDS.length) return true;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;
  const ids = member.roles.cache.map(r => r.id);
  return BITACORA_ROLE_IDS.some(id => ids.includes(id));
}

// ------------------------------
// Panel
// ------------------------------
function buildPanelEmbed(enServicioTags = '—', cfg = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xf7a8d8)
    .setTitle('Lollipop Bitácora')
    .setDescription([
      '**Bitácora de Servicio**',
      'Usa los botones para **Entrar/Salir** o **Descanso/Reanudar**.',
      '• Horas estelares diarias: **4–6 PM** y **12–2 AM**',
      `• Zona horaria: **${cfg.timezone || TZ}**`,
      '',
      `**En servicio ahora:** ${enServicioTags}`,
      '',
      '_Tarifa_: 1 coin/h normal · 2 coins/h estelar',
    ].join('\n'));

  if (process.env.PANEL_GIF_URL) embed.setImage(process.env.PANEL_GIF_URL);
  if (process.env.PANEL_LOGO_URL) embed.setThumbnail(process.env.PANEL_LOGO_URL);

  return embed;
}

function buildPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('bitacora_start').setLabel('Entrar').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('bitacora_stop').setLabel('Salir').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('bitacora_pause').setLabel('Descanso').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('bitacora_resume').setLabel('Reanudar').setStyle(ButtonStyle.Primary),
  );
}

async function refreshPanel(guildId) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg?.panel_channel_id || !cfg?.panel_message_id) return;

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const ch = await guild.channels.fetch(cfg.panel_channel_id).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;

  const msg = await ch.messages.fetch(cfg.panel_message_id).catch(() => null);
  if (!msg) return;

  db.all(
    `SELECT user_id FROM sessions WHERE guild_id=? AND status='open'`,
    [guildId],
    async (e, rows = []) => {
      const tags = rows.length ? rows.map(r => `<@${r.user_id}>`).join(' ') : '—';
      const embed = buildPanelEmbed(tags, cfg);
      const row = buildPanelButtons();
      await msg.edit({ embeds: [embed], components: [row] });
    }
  );
}

// ------------------------------
// Sesiones helpers
// ------------------------------
function openSession(guildId, userId) {
  return new Promise(res => {
    db.get(
      `SELECT id FROM sessions WHERE guild_id=? AND user_id=? AND status='open'`,
      [guildId, userId],
      (e, row) => {
        if (row) return res(null);
        db.run(
          `INSERT INTO sessions (guild_id, user_id, status, start_at)
           VALUES (?,?, 'open', ?)`,
          [guildId, userId, Date.now()],
          () => res(true)
        );
      }
    );
  });
}

function activeOpenSession(guildId, userId) {
  return new Promise(res => {
    db.get(
      `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND status IN ('open','paused') ORDER BY id DESC LIMIT 1`,
      [guildId, userId],
      (e, row) => res(row || null)
    );
  });
}

function pauseSession(sessionId) {
  return new Promise(res => {
    db.get(`SELECT id FROM pauses WHERE session_id=? AND pause_end IS NULL`, [sessionId], (e, row) => {
      if (row) return res(false);
      db.run(`INSERT INTO pauses (session_id, pause_start) VALUES (?,?)`, [sessionId, Date.now()], () => res(true));
    });
  });
}

function resumeSession(sessionId) {
  return new Promise(res => {
    db.get(`SELECT id FROM pauses WHERE session_id=? AND pause_end IS NULL`, [sessionId], (e, row) => {
      if (!row) return res(false);
      db.run(`UPDATE pauses SET pause_end=? WHERE id=?`, [Date.now(), row.id], () => res(true));
    });
  });
}

async function closeSessionCompute(session) {
  const end = Date.now();

  const pauses = await new Promise(res =>
    db.all(`SELECT pause_start, pause_end FROM pauses WHERE session_id=?`, [session.id], (e, r = []) => res(r))
  );

  // minutos efectivos
  const activeMin = minutesMinusPauses(session.start_at, end, pauses);
  const cfg = await getGuildConfig(session.guild_id);
  const tz = cfg?.timezone || TZ;
  const windows = parseWindows(cfg?.stellar_windows || '00:00-02:00,16:00-18:00');

  const fromEffective = end - activeMin * 60000;
  const split = splitMinutesByWindows(fromEffective, end, tz, windows);

  await new Promise(res =>
    db.run(
      `UPDATE sessions
       SET status='closed', end_at=?, min_normales=min_normales+?, min_estelares=min_estelares+?
       WHERE id=?`,
      [end, split.normales, split.estelares, session.id],
      () => res()
    )
  );
  return split; // {normales, estelares}
}

// ------------------------------
// Logs
// ------------------------------
async function sendLog(guildId, content, files = []) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg?.logs_channel_id) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;
  const ch = await guild.channels.fetch(cfg.logs_channel_id).catch(() => null);
  if (!ch) return;
  await ch.send({ content, files }).catch(() => {});
}

// ------------------------------
// Backups (semanal + nocturno)
// ------------------------------
async function weeklyArchive(guildId) {
  const now = Date.now();
  const dateStr = DateTime.now().setZone(TZ).toFormat('yyyy-LL-dd_HH-mm');
  const csvPath = path.join(BACKUP_DIR, `weekly_${guildId}_${dateStr}.csv`);

  const rows = await new Promise(res =>
    db.all(`SELECT * FROM sessions WHERE guild_id=?`, [guildId], (e, r = []) => res(r))
  );

  await new Promise(res => {
    const columns = ['id','user_id','status','start_at','end_at','min_normales','min_estelares','reason'];
    const stringifier = stringify({ header: true, columns });
    const writable = fs.createWriteStream(csvPath);
    stringifier.pipe(writable);
    for (const r of rows) {
      stringifier.write({
        id: r.id, user_id: r.user_id, status: r.status,
        start_at: r.start_at, end_at: r.end_at || '',
        min_normales: r.min_normales || 0, min_estelares: r.min_estelares || 0,
        reason: r.reason || ''
      });
    }
    stringifier.end();
    writable.on('finish', res);
  });

  await new Promise(res => {
    db.run(
      `INSERT INTO sessions_history SELECT *, ? AS archived_at FROM sessions WHERE guild_id=?`,
      [now, guildId],
      () => {
        db.run(`DELETE FROM sessions WHERE guild_id=?`, [guildId], () => {
          db.run(`DELETE FROM pauses WHERE session_id NOT IN (SELECT id FROM sessions)`, [], () => res());
        });
      }
    );
  });

  await sendLog(guildId, `📦 **Backup semanal** generado`, [csvPath]);
}

async function nightlyBackupForGuild(guildId) {
  const cfg = await getGuildConfig(guildId);
  if (!cfg) return;
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const serverName = guild.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  const dateStr = DateTime.now().setZone(TZ).toFormat('yyyy-LL-dd');
  const dailyDir = path.join(BACKUP_DIR, 'daily');
  await fs.ensureDir(dailyDir);

  const sessions = await new Promise(res => db.all(`SELECT * FROM sessions WHERE guild_id=?`, [guildId], (e,r=[])=>res(r)));
  const pauses = await new Promise(res => db.all(
    `SELECT * FROM pauses WHERE session_id IN (SELECT id FROM sessions WHERE guild_id=?)`,
    [guildId], (e,r=[])=>res(r)
  ));
  const adjustments = await new Promise(res => db.all(
    `SELECT * FROM adjustments WHERE guild_id=?`, [guildId], (e,r=[])=>res(r)
  ));

  const base = `nightly_${serverName}_${dateStr}`;
  const jsonPath = path.join(dailyDir, `${base}.json`);
  await fs.writeJson(jsonPath, {
    guild_id: guildId, server_name: guild.name, created_at: Date.now(),
    timezone: cfg.timezone || TZ, sessions, pauses, adjustments,
  }, { spaces: 2 });

  const csvPath = path.join(dailyDir, `${base}.csv`);
  await new Promise(res => {
    const columns = ['id','user_id','status','start_at','end_at','min_normales','min_estelares','reason'];
    const stringifier = stringify({ header: true, columns });
    const writable = fs.createWriteStream(csvPath);
    stringifier.pipe(writable);
    for (const r of sessions) {
      stringifier.write({
        id: r.id, user_id: r.user_id, status: r.status,
        start_at: r.start_at, end_at: r.end_at || '',
        min_normales: r.min_normales || 0, min_estelares: r.min_estelares || 0,
        reason: r.reason || ''
      });
    }
    stringifier.end();
    writable.on('finish', res);
  });

  if (NIGHTLY_UPLOAD && cfg.logs_channel_id) {
    const ch = await guild.channels.fetch(cfg.logs_channel_id).catch(() => null);
    if (ch) await ch.send({ content: `🌙 Respaldo nocturno **${dateStr}**`, files: [jsonPath, csvPath] });
  }
}

// CRON: semana y noche
cron.schedule('0 17 * * 5', async () => {
  for (const g of client.guilds.cache.values()) await weeklyArchive(g.id);
}, { timezone: TZ });

cron.schedule('30 3 * * *', async () => {
  for (const g of client.guilds.cache.values()) await nightlyBackupForGuild(g.id);
}, { timezone: TZ });

// ------------------------------
// Pings por DM cada PING_EVERY_MIN
// ------------------------------
cron.schedule('*/5 * * * *', async () => {
  for (const guild of client.guilds.cache.values()) {
    const cfg = await getGuildConfig(guild.id);
    const every = cfg?.ping_every_min || PING_EVERY_MIN;
    const timeout = cfg?.ping_timeout_min || PING_TIMEOUT_MIN;

    db.all(`SELECT * FROM sessions WHERE guild_id=? AND status='open'`,
      [guild.id],
      async (e, rows = []) => {
        for (const s of rows) {
          const now = Date.now();

          // Lanzar DM si toca
          if (!s.last_ping_at || now - s.last_ping_at >= every * 60000) {
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`ping_yes:${s.id}`).setLabel('Sí, sigo en servicio').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`ping_close:${s.id}`).setLabel('Cerrar ahora').setStyle(ButtonStyle.Danger),
            );

            // DM primero
            const user = await client.users.fetch(s.user_id).catch(()=>null);
            let sent = false;
            if (user) {
              sent = await user.send({ content: '¿Sigues en servicio?', components: [row] }).then(()=>true).catch(()=>false);
            }
            // Fallback a logs si DM falla
            if (!sent) {
              const ch = cfg?.logs_channel_id ? await guild.channels.fetch(cfg.logs_channel_id).catch(()=>null) : null;
              await ch?.send({ content: `<@${s.user_id}> ¿Sigues en servicio?`, components: [row] });
            }

            db.run(`UPDATE sessions SET last_ping_at=?, pending_ping=1 WHERE id=?`, [now, s.id]);
          }
          // Autocierre por no responder
          else if (s.pending_ping && now - s.last_ping_at >= timeout * 60000) {
            const fresh = await new Promise(r => db.get(`SELECT * FROM sessions WHERE id=?`, [s.id], (e2,row)=>r(row)));
            if (fresh?.status === 'open') {
              await closeSessionCompute(fresh);
              await sendLog(guild.id, `⏱️ Cierre automático por no responder: <@${fresh.user_id}>`);
              await refreshPanel(guild.id);
            }
          }
        }
      }
    );
  }
}, { timezone: TZ });

// ------------------------------
// Interactions
// ------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // Slash
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'bitacora') {
        const sub = interaction.options.getSubcommand();

        if (sub === 'panel') {
          const ch = interaction.options.getChannel('canal', true);
          if (ch.type !== ChannelType.GuildText)
            return interaction.reply({ content: 'El canal debe ser de texto.', ephemeral: true });

          const cfg = (await getGuildConfig(interaction.guildId)) || { guild_id: interaction.guildId };
          const embed = buildPanelEmbed('—', cfg);
          const row = buildPanelButtons();

          const msg = await ch.send({ embeds: [embed], components: [row] });
          await upsertGuildConfig({ guild_id: interaction.guildId, panel_channel_id: ch.id, panel_message_id: msg.id });
          return interaction.reply({ content: 'Panel publicado/actualizado ✅', ephemeral: true });
        }

        if (sub === 'config') {
          const updates = { guild_id: interaction.guildId };
          const chLogs = interaction.options.getChannel('canal_logs');
          const every = interaction.options.getInteger('ping_cada_min');
          const timeout = interaction.options.getInteger('ping_timeout_min');
          if (chLogs) updates.logs_channel_id = chLogs.id;
          if (every) updates.ping_every_min = every;
          if (timeout) updates.ping_timeout_min = timeout;

          await upsertGuildConfig(updates);
          return interaction.reply({ content: 'Configuración guardada ✅', ephemeral: true });
        }

        if (sub === 'all') {
          await handleAll(interaction); // histórico (sessions + history)
          return;
        }

        if (sub === 'top') {
          const periodo = interaction.options.getString('periodo', true); // hoy|semana|mes
          await handleTop(interaction, periodo);
          return;
        }
      }
    }

    // Botones (panel + pings)
    if (interaction.isButton()) {
      const id = interaction.customId;

      // --- botones DM ping ---
      if (id.startsWith('ping_yes:') || id.startsWith('ping_close:')) {
        const sid = id.split(':')[1];
        const session = await new Promise(r => db.get(`SELECT * FROM sessions WHERE id=?`, [sid], (e,row)=>r(row)));
        if (!session) return interaction.reply({ content: 'Sesión no encontrada.', ephemeral: true }).catch(()=>{});

        if (id.startsWith('ping_yes:')) {
          db.run(`UPDATE sessions SET pending_ping=0, last_ping_at=? WHERE id=?`, [Date.now(), sid]);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('x1').setLabel('Sí, sigo en servicio').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('x2').setLabel('Cerrar ahora').setStyle(ButtonStyle.Danger).setDisabled(true),
          );
          // Si fue en DM, usamos update; si fue en canal, igual.
          return interaction.update({ content: '¡Perfecto! Seguimos contando tu servicio 💪', components: [row] }).catch(async ()=>{
            await interaction.reply({ content:'¡Perfecto! Seguimos contando tu servicio 💪', ephemeral:true }).catch(()=>{});
          });
        }

        if (id.startsWith('ping_close:')) {
          if (session.status === 'open') {
            const split = await closeSessionCompute(session);
            await refreshPanel(session.guild_id);
            await sendLog(session.guild_id, `⏹️ Cierre manual desde ping: <@${session.user_id}> (+${formatH(split.normales)} normal, +${formatH(split.estelares)} estelar)`);
          }
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('x1').setLabel('Sí, sigo en servicio').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('x2').setLabel('Cerrar ahora').setStyle(ButtonStyle.Danger).setDisabled(true),
          );
          return interaction.update({ content: 'Sesión cerrada ✅', components: [row] }).catch(async ()=>{
            await interaction.reply({ content:'Sesión cerrada ✅', ephemeral:true }).catch(()=>{});
          });
        }
      }

      // --- panel ---
      const ephemeralAck = (content) => interaction.reply({ content, ephemeral: true }).catch(()=>{});

      if (id === 'bitacora_start') {
        const ok = await openSession(interaction.guildId, interaction.user.id);
        if (!ok) return ephemeralAck('Ya tienes una bitácora abierta.');
        await sendLog(interaction.guildId, `🟢 <@${interaction.user.id}> **entró** en servicio.`);
        await refreshPanel(interaction.guildId);
        return ephemeralAck('Has iniciado tu bitácora — ¡buen servicio! 💖');
      }

      if (id === 'bitacora_stop') {
        const s = await activeOpenSession(interaction.guildId, interaction.user.id);
        if (!s || s.status === 'closed') return ephemeralAck('No tienes una bitácora abierta.');
        const res = await closeSessionCompute(s);
        const coins = (res.normales/60)*1 + (res.estelares/60)*2;
        await sendLog(interaction.guildId, `🔴 <@${interaction.user.id}> **salió** (+${formatH(res.normales)} normal, +${formatH(res.estelares)} estelar = **${coins.toFixed(2)} coins**)`);
        await refreshPanel(interaction.guildId);
        return ephemeralAck('Cerraste tu bitácora. ¡Gracias por tu servicio! ✨');
      }

      if (id === 'bitacora_pause') {
        const s = await activeOpenSession(interaction.guildId, interaction.user.id);
        if (!s || s.status === 'closed') return ephemeralAck('No tienes una bitácora abierta.');
        const ok = await pauseSession(s.id);
        if (!ok) return ephemeralAck('Ya estabas en descanso.');
        db.run(`UPDATE sessions SET status='paused' WHERE id=?`, [s.id]);
        await sendLog(interaction.guildId, `⏸️ <@${interaction.user.id}> **descanso** iniciado.`);
        return ephemeralAck('Descanso iniciado. ⏸️');
      }

      if (id === 'bitacora_resume') {
        const s = await activeOpenSession(interaction.guildId, interaction.user.id);
        if (!s || s.status === 'closed') return ephemeralAck('No tienes una bitácora abierta.');
        const ok = await resumeSession(s.id);
        if (!ok) return ephemeralAck('No estabas en descanso.');
        db.run(`UPDATE sessions SET status='open' WHERE id=?`, [s.id]);
        await sendLog(interaction.guildId, `▶️ <@${interaction.user.id}> **reanuda** servicio.`);
        await refreshPanel(interaction.guildId);
        return ephemeralAck('Servicio reanudado. ▶️');
      }
    }
  } catch (e) {
    console.error('interaction error', e);
  }
});

// ------------------------------
// /bitacora all — histórico (sessions + sessions_history)
// ------------------------------
async function handleAll(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const guildId = interaction.guildId;

  const totals = new Map(); // userId -> { n, e }

  // Suma de sessions + history
  await new Promise(res => {
    db.all(
      `
      SELECT user_id, SUM(min_normales) AS n, SUM(min_estelares) AS e
      FROM (
        SELECT user_id, min_normales, min_estelares FROM sessions WHERE guild_id=?
        UNION ALL
        SELECT user_id, min_normales, min_estelares FROM sessions_history WHERE guild_id=?
      ) t
      GROUP BY user_id
      `,
      [guildId, guildId],
      (e, rows = []) => {
        for (const r of rows) totals.set(r.user_id, { n: r.n || 0, e: r.e || 0 });
        res();
      }
    );
  });

  // Añadimos lo abierto ahora (recalculado por ventanas)
  const cfg = await getGuildConfig(guildId);
  const tz = cfg?.timezone || TZ;
  const windows = parseWindows(cfg?.stellar_windows || '00:00-02:00,16:00-18:00');

  const openRows = await new Promise(res =>
    db.all(`SELECT id, user_id, start_at FROM sessions WHERE guild_id=? AND status='open'`, [guildId], (e, r=[]) => res(r))
  );

  for (const s of openRows) {
    const pauses = await new Promise(res => db.all(
      `SELECT pause_start, pause_end FROM pauses WHERE session_id=?`, [s.id], (e,r=[]) => res(r)
    ));
    const end = Date.now();
    const activeMin = minutesMinusPauses(s.start_at, end, pauses);
    if (activeMin > 0) {
      const fromEff = end - activeMin * 60000;
      const split = splitMinutesByWindows(fromEff, end, tz, windows);
      const prev = totals.get(s.user_id) || { n: 0, e: 0 };
      totals.set(s.user_id, { n: prev.n + split.normales, e: prev.e + split.estelares });
    }
  }

  if (!totals.size) return interaction.editReply('Aún no hay registros.');

  const arr = [...totals.entries()].map(([userId, v]) => ({
    userId, n: v.n, e: v.e, coins: (v.n/60)*1 + (v.e/60)*2
  })).sort((a, b) => b.coins - a.coins);

  const lines = arr.slice(0, 25).map((r,i) =>
    `**${i+1}.** <@${r.userId}> — ${r.coins.toFixed(2)} coins (Normales ${(r.n/60).toFixed(2)}h · Estelares ${(r.e/60).toFixed(2)}h)`
  ).join('\n');

  const embed = new EmbedBuilder()
    .setColor(0xf7a8d8)
    .setTitle('📚 Bitácora — Total histórico (todos)')
    .setDescription(lines || ' ');

  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------
// /bitacora top — hoy|semana|mes
// ------------------------------
async function handleTop(interaction, periodo) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId;
  const cfg = await getGuildConfig(guildId);
  const tz = cfg?.timezone || TZ;
  const windows = parseWindows(cfg?.stellar_windows || '00:00-02:00,16:00-18:00');

  const range = getPeriodRange(periodo, tz);
  if (!range) return interaction.editReply('Período inválido.');

  // 1) Sumar sesiones CERRADAS actuales (recalcular por rango + pausas)
  const closed = await new Promise(res => db.all(
    `SELECT s.*, p.pause_start, p.pause_end
     FROM sessions s
     LEFT JOIN pauses p ON p.session_id=s.id
     WHERE s.guild_id=? AND s.status='closed'`,
    [guildId],
    (e, rows=[]) => res(rows)
  ));

  // agrupamos por sesión para tener todas sus pausas
  const pausesBySession = new Map();
  for (const r of closed) {
    if (!pausesBySession.has(r.id)) pausesBySession.set(r.id, []);
    if (r.pause_start) pausesBySession.get(r.id).push({ pause_start: r.pause_start, pause_end: r.pause_end });
  }
  const baseClosed = await new Promise(res => db.all(
    `SELECT * FROM sessions WHERE guild_id=? AND status='closed'`,
    [guildId], (e, rows=[]) => res(rows)
  ));

  const sums = new Map(); // userId -> {n,e}

  function add(userId, n, e) {
    const prev = sums.get(userId) || { n:0, e:0 };
    sums.set(userId, { n: prev.n + n, e: prev.e + e });
  }

  for (const s of baseClosed) {
    const from = Math.max(s.start_at, range.from);
    const to = Math.min(s.end_at || s.start_at, range.to);
    if (to <= from) continue;

    const pauses = pausesBySession.get(s.id) || [];
    const activeMin = minutesMinusPauses(from, to, pauses);
    if (activeMin <= 0) continue;

    const split = splitMinutesByWindows(to - activeMin*60000, to, tz, windows);
    add(s.user_id, split.normales, split.estelares);
  }

  // 2) Sumar sesiones ABIERTAS (hasta ahora)
  const openRows = await new Promise(res =>
    db.all(`SELECT id, user_id, start_at FROM sessions WHERE guild_id=? AND status='open'`,
      [guildId], (e,r=[]) => res(r))
  );
  for (const s of openRows) {
    const from = Math.max(s.start_at, range.from);
    const to = Math.min(Date.now(), range.to);
    if (to <= from) continue;

    const pauses = await new Promise(res =>
      db.all(`SELECT pause_start, pause_end FROM pauses WHERE session_id=?`, [s.id], (e,r=[])=>res(r))
    );
    const activeMin = minutesMinusPauses(from, to, pauses);
    if (activeMin <= 0) continue;

    const split = splitMinutesByWindows(to - activeMin*60000, to, tz, windows);
    add(s.user_id, split.normales, split.estelares);
  }

  // 3) Sumar sessions_history (aprox: registros cuyo end_at cae dentro del rango)
  const histRows = await new Promise(res =>
    db.all(
      `SELECT user_id, min_normales, min_estelares, end_at
       FROM sessions_history
       WHERE guild_id=? AND end_at BETWEEN ? AND ?`,
      [guildId, range.from, range.to],
      (e, rows=[]) => res(rows)
    )
  );
  for (const r of histRows) add(r.user_id, r.min_normales || 0, r.min_estelares || 0);

  if (!sums.size) return interaction.editReply('Sin datos en ese período.');

  const arr = [...sums.entries()].map(([userId, v]) => ({
    userId, n: v.n, e: v.e, coins: (v.n/60)*1 + (v.e/60)*2
  })).sort((a,b) => b.coins - a.coins);

  const title = periodo === 'hoy' ? '📊 Top — Hoy'
              : periodo === 'semana' ? '📊 Top — Semana'
              : '📊 Top — Mes';

  const lines = arr.slice(0, 25).map((r,i) =>
    `**${i+1}.** <@${r.userId}> — ${r.coins.toFixed(2)} coins (Normales ${(r.n/60).toFixed(2)}h · Estelares ${(r.e/60).toFixed(2)}h)`
  ).join('\n');

  const embed = new EmbedBuilder().setColor(0xf7a8d8).setTitle(title).setDescription(lines || ' ');
  await interaction.editReply({ embeds: [embed] });
}

// ------------------------------
// Ready
// ------------------------------
client.once(Events.ClientReady, async (c) => {
  console.log(`Bot listo como ${c.user.tag}`);
  initDb();
  for (const g of c.guilds.cache.values()) await refreshPanel(g.id);
});

// ------------------------------
// Login
// ------------------------------
client.login(process.env.DISCORD_TOKEN);

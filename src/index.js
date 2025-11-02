// src/index.js
import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from 'discord.js';
import sqlite3 from 'sqlite3';
import { DateTime, Interval } from 'luxon';
import cron from 'node-cron';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import { stringify } from 'csv-stringify';

// ------------------------------
// Paths / constants
// ------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TZ = process.env.TIMEZONE || 'America/Mexico_City';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'bitacora.db');

const BITACORA_ROLE_IDS =
  (process.env.BITACORA_ROLE_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const PING_EVERY_MIN = parseInt(process.env.PING_EVERY_MIN || '120', 10); // cada 2h
const PING_TIMEOUT_MIN = parseInt(process.env.PING_TIMEOUT_MIN || '5', 10);

const NIGHTLY_UPLOAD =
  String(process.env.NIGHTLY_BACKUP_UPLOAD || 'false').toLowerCase() === 'true';

// Rutas locales
const DATA_DIR = path.join(__dirname, '..');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

await fs.ensureDir(BACKUP_DIR);

// ------------------------------
// DB & schema
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
      stellar_windows  TEXT,    -- '00:00-02:00,16:00-18:00'
      ping_every_min   INTEGER, -- default 120
      ping_timeout_min INTEGER  -- default 5
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      status        TEXT NOT NULL, -- open|paused|closed
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
            panel_channel_id=?,
            panel_message_id=?,
            logs_channel_id=?,
            timezone=?,
            stellar_windows=?,
            ping_every_min=?,
            ping_timeout_min=?
           WHERE guild_id=?`,
          [
            data.panel_channel_id,
            data.panel_message_id,
            data.logs_channel_id,
            data.timezone,
            data.stellar_windows,
            data.ping_every_min,
            data.ping_timeout_min,
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
            cfg.guild_id,
            data.panel_channel_id,
            data.panel_message_id,
            data.logs_channel_id,
            data.timezone,
            data.stellar_windows,
            data.ping_every_min,
            data.ping_timeout_min,
          ],
          () => res()
        );
      }
    });
  });
}

// ------------------------------
// Time helpers & stellar windows
// ------------------------------
function parseWindows(spec = '00:00-02:00,16:00-18:00') {
  const parts = spec.split(',').map(s => s.trim()).filter(Boolean);
  return parts.map(p => {
    const [a, b] = p.split('-').map(s => s.trim());
    return { from: a, to: b };
  });
}

function splitMinutesByWindows(fromMs, toMs, timezone, windows) {
  // Devuelve {normales, estelares} en minutos
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
      // ventana dentro del mismo día
      return Interval.fromDateTimes(s, e).contains(DateTime.fromFormat(hhmm, 'HH:mm', { zone: timezone }));
    });
    if (inStellar) estelares += 1;
    else normales += 1;
    cursor = next;
  }

  return { normales, estelares };
}

function formatH(mins) {
  return (mins / 60).toFixed(2) + 'h';
}

// ------------------------------
// Discord client
// ------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ------------------------------
// Permissions helper (roles para acciones admin si los usas)
// ------------------------------
async function userHasBitacoraAccess(interaction) {
  if (!BITACORA_ROLE_IDS.length) return true; // si no configuraste nada, abierto
  if (!interaction.guild) return false;

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return false;
  const memberRoleIds = member.roles.cache.map(r => r.id);
  return BITACORA_ROLE_IDS.some(id => memberRoleIds.includes(id));
}

// ------------------------------
// Panel & UI
// ------------------------------
function buildPanelEmbed(enServicioTags = '—', cfg = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xf7a8d8)
    .setTitle('Lollipop Bitácora')
    .setDescription(
      [
        '**Bitácora de Servicio**',
        'Usa los botones para **Entrar/Salir** o **Descanso/Reanudar**.',
        '• Horas estelares diarias: **4–6 PM** y **12–2 AM**',
        `• Zona horaria: **${cfg.timezone || TZ}**`,
        '',
        `**En servicio ahora:** ${enServicioTags}`,
        '',
        '_Tarifa_: 1 coin/h normal · 2 coins/h estelar',
      ].join('\n')
    );

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
    // (Quitado) Botón Bitácora/lista
    // new ButtonBuilder().setCustomId('bitacora_list').setLabel('Bitácora').setStyle(ButtonStyle.Secondary)
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
      await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
    }
  );
}

// ------------------------------
// Helpers de sesiones
// ------------------------------
function openSession(guildId, userId) {
  return new Promise(res => {
    db.get(
      `SELECT id FROM sessions WHERE guild_id=? AND user_id=? AND status='open'`,
      [guildId, userId],
      (e, row) => {
        if (row) return res(null); // ya había
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

function closeSessionCompute(session) {
  return new Promise(res => {
    const end = Date.now();

    // Traer pausas de la sesión
    db.all(`SELECT * FROM pauses WHERE session_id=?`, [session.id], (e, pauses = []) => {
      // Restar pausas del rango efectivo
      let effectiveStart = session.start_at;
      // minutos activos totales
      let activeMinutes = 0;

      // Método simple: avanzamos minuto a minuto respecto a pausas (OK por rangos medianos)
      const pausesIntervals = pauses.map(p => ({
        from: p.pause_start,
        to: p.pause_end || end,
      }));

      let cursor = session.start_at;
      while (cursor < end) {
        const next = cursor + 60000;
        const inPause = pausesIntervals.some(iv => next > iv.from && cursor < iv.to);
        if (!inPause) activeMinutes += 1;
        cursor = next;
      }

      // Separar por ventanas estelares
      const cfgFetch = () =>
        new Promise(r =>
          db.get(`SELECT timezone, stellar_windows FROM guild_config WHERE guild_id=?`, [session.guild_id], (e2, c) =>
            r(c || { timezone: TZ, stellar_windows: '00:00-02:00,16:00-18:00' })
          )
        );

      cfgFetch().then(cfg => {
        const tz = cfg.timezone || TZ;
        const windows = parseWindows(cfg.stellar_windows || '00:00-02:00,16:00-18:00');

        const fromEffective = end - activeMinutes * 60000;
        const split = splitMinutesByWindows(fromEffective, end, tz, windows);

        db.run(
          `UPDATE sessions SET status='closed', end_at=?, min_normales=min_normales+?, min_estelares=min_estelares+?
           WHERE id=?`,
          [end, split.normales, split.estelares, session.id],
          () => res({ normales: split.normales, estelares: split.estelares })
        );
      });
    });
  });
}

function pauseSession(sessionId) {
  return new Promise(res => {
    db.get(`SELECT id FROM pauses WHERE session_id=? AND pause_end IS NULL`, [sessionId], (e, row) => {
      if (row) return res(false);
      db.run(
        `INSERT INTO pauses (session_id, pause_start) VALUES (?,?)`,
        [sessionId, Date.now()],
        () => res(true)
      );
    });
  });
}

function resumeSession(sessionId) {
  return new Promise(res => {
    db.get(`SELECT id FROM pauses WHERE session_id=? AND pause_end IS NULL`, [sessionId], (e, row) => {
      if (!row) return res(false);
      db.run(
        `UPDATE pauses SET pause_end=? WHERE id=?`,
        [Date.now(), row.id],
        () => res(true)
      );
    });
  });
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
// Backups — semanal & nocturno
// ------------------------------
async function weeklyArchive(guildId) {
  const now = Date.now();
  const dateStr = DateTime.now().setZone(TZ).toFormat('yyyy-LL-dd_HH-mm');
  const csvPath = path.join(BACKUP_DIR, `weekly_${guildId}_${dateStr}.csv`);

  const rows = await new Promise(res => {
    db.all(
      `SELECT * FROM sessions WHERE guild_id=?`,
      [guildId],
      (e, r = []) => res(r)
    );
  });

  // CSV
  await new Promise(res => {
    const columns = [
      'id', 'user_id', 'status', 'start_at', 'end_at', 'min_normales', 'min_estelares', 'reason'
    ];
    const stringifier = stringify({ header: true, columns });
    const writable = fs.createWriteStream(csvPath);
    stringifier.pipe(writable);
    for (const r of rows) {
      stringifier.write({
        id: r.id,
        user_id: r.user_id,
        status: r.status,
        start_at: r.start_at,
        end_at: r.end_at || '',
        min_normales: r.min_normales || 0,
        min_estelares: r.min_estelares || 0,
        reason: r.reason || ''
      });
    }
    stringifier.end();
    writable.on('finish', res);
  });

  // Archivar & limpiar
  await new Promise(res => {
    db.run(
      `INSERT INTO sessions_history SELECT *, ? AS archived_at FROM sessions WHERE guild_id=?`,
      [now, guildId],
      () => {
        db.run(`DELETE FROM sessions WHERE guild_id=?`, [guildId], () => {
          db.run(
            `DELETE FROM pauses WHERE session_id NOT IN (SELECT id FROM sessions)`,
            [],
            () => res()
          );
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

  const sessions = await new Promise(res =>
    db.all(`SELECT * FROM sessions WHERE guild_id=?`, [guildId], (e, r = []) => res(r))
  );
  const pauses = await new Promise(res =>
    db.all(
      `SELECT * FROM pauses WHERE session_id IN (SELECT id FROM sessions WHERE guild_id=?)`,
      [guildId],
      (e, r = []) => res(r)
    )
  );
  const adjustments = await new Promise(res =>
    db.all(`SELECT * FROM adjustments WHERE guild_id=?`, [guildId], (e, r = []) => res(r))
  );

  const baseName = `nightly_${serverName}_${dateStr}`;
  const jsonPath = path.join(dailyDir, `${baseName}.json`);
  await fs.writeJson(
    jsonPath,
    {
      guild_id: guildId,
      server_name: guild.name,
      created_at: Date.now(),
      timezone: cfg.timezone || TZ,
      sessions,
      pauses,
      adjustments,
    },
    { spaces: 2 }
  );

  // CSV de sesiones
  const csvPath = path.join(dailyDir, `${baseName}.csv`);
  await new Promise(res => {
    const columns = [
      'id', 'user_id', 'status', 'start_at', 'end_at', 'min_normales', 'min_estelares', 'reason'
    ];
    const stringifier = stringify({ header: true, columns });
    const writable = fs.createWriteStream(csvPath);
    stringifier.pipe(writable);
    for (const r of sessions) {
      stringifier.write({
        id: r.id,
        user_id: r.user_id,
        status: r.status,
        start_at: r.start_at,
        end_at: r.end_at || '',
        min_normales: r.min_normales || 0,
        min_estelares: r.min_estelares || 0,
        reason: r.reason || '',
      });
    }
    stringifier.end();
    writable.on('finish', res);
  });

  if (NIGHTLY_UPLOAD && cfg.logs_channel_id) {
    const ch = await guild.channels.fetch(cfg.logs_channel_id).catch(() => null);
    if (ch) {
      await ch.send({
        content: `🌙 Respaldo nocturno generado **${dateStr}**`,
        files: [jsonPath, csvPath],
      });
    }
  }

  // Rotación 14 días
  try {
    const files = await fs.readdir(dailyDir);
    const limitMs = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    await Promise.all(
      files
        .filter(f => f.startsWith('nightly_') && (f.endsWith('.json') || f.endsWith('.csv')))
        .map(async f => {
          const fp = path.join(dailyDir, f);
          const st = await fs.stat(fp);
          if (now - st.mtimeMs > limitMs) await fs.remove(fp);
        })
    );
  } catch (e) {}
}

// CRONs
// Viernes 17:00 CDMX -> backup semanal
cron.schedule('0 17 * * 5', async () => {
  for (const g of client.guilds.cache.values()) await weeklyArchive(g.id);
}, { timezone: TZ });

// Diario 03:30 -> respaldo nocturno
cron.schedule('30 3 * * *', async () => {
  for (const g of client.guilds.cache.values()) await nightlyBackupForGuild(g.id);
}, { timezone: TZ });

// ------------------------------
// Pings de seguimiento global (simple y efectivo)
// ------------------------------
cron.schedule('*/5 * * * *', async () => {
  // Corre cada 5 minutos, pero respeta PING_EVERY_MIN y timeout por usuario
  for (const guild of client.guilds.cache.values()) {
    const cfg = await getGuildConfig(guild.id);
    const every = cfg?.ping_every_min || PING_EVERY_MIN;
    const timeout = cfg?.ping_timeout_min || PING_TIMEOUT_MIN;

    db.all(
      `SELECT * FROM sessions WHERE guild_id=? AND status='open'`,
      [guild.id],
      async (e, rows = []) => {
        for (const s of rows) {
          const now = Date.now();
          if (!s.last_ping_at || now - s.last_ping_at >= every * 60000) {
            // mandar ping
            const ch = cfg?.logs_channel_id
              ? await guild.channels.fetch(cfg.logs_channel_id).catch(() => null)
              : null;
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`ping_yes:${s.id}`).setLabel('Sí, sigo en servicio').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`ping_close:${s.id}`).setLabel('Cerrar ahora').setStyle(ButtonStyle.Danger)
            );
            await ch?.send({ content: `<@${s.user_id}> ¿Sigues en servicio?`, components: [row] }).catch(() => {});
            db.run(`UPDATE sessions SET last_ping_at=?, pending_ping=1 WHERE id=?`, [now, s.id]);
          } else if (s.pending_ping && now - s.last_ping_at >= timeout * 60000) {
            // autocierre por no contestar
            const fresh = await new Promise(r =>
              db.get(`SELECT * FROM sessions WHERE id=?`, [s.id], (e2, row) => r(row))
            );
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
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'bitacora') {
        const sub = interaction.options.getSubcommand();

        // /bitacora panel canal:#canal
        if (sub === 'panel') {
          const ch = interaction.options.getChannel('canal', true);
          if (ch.type !== ChannelType.GuildText)
            return interaction.reply({ content: 'El canal debe ser de texto.', ephemeral: true });

          // publicar/actualizar
          const cfg = (await getGuildConfig(interaction.guildId)) || { guild_id: interaction.guildId };
          const embed = buildPanelEmbed('—', cfg);
          const row = buildPanelButtons();

          let msg;
          if (cfg.panel_channel_id && cfg.panel_message_id && cfg.panel_channel_id === ch.id) {
            const existing = await ch.messages.fetch(cfg.panel_message_id).catch(() => null);
            if (existing) {
              msg = await existing.edit({ embeds: [embed], components: [row] });
            }
          }
          if (!msg) {
            msg = await ch.send({ embeds: [embed], components: [row] });
          }

          await upsertGuildConfig({
            guild_id: interaction.guildId,
            panel_channel_id: ch.id,
            panel_message_id: msg.id,
          });

          await interaction.reply({ content: 'Panel publicado/actualizado ✅', ephemeral: true });
          return;
        }

        // /bitacora config canal_logs:#canal
        if (sub === 'config') {
          const ch = interaction.options.getChannel('canal_logs', true);
          if (ch.type !== ChannelType.GuildText)
            return interaction.reply({ content: 'El canal debe ser de texto.', ephemeral: true });

          await upsertGuildConfig({ guild_id: interaction.guildId, logs_channel_id: ch.id });
          await interaction.reply({ content: 'Canal de logs configurado ✅', ephemeral: true });
          return;
        }

        // /bitacora all  -> ranking completo histórico (sumando abiertas)
        if (sub === 'all') {
          await handleAll(interaction);
          return;
        }
      }
    }

    // Botones
    if (interaction.isButton()) {
      // Respuestas efímeras en notificaciones
      const ephemeralAck = (content) => interaction.reply({ content, ephemeral: true }).catch(() => {});
      const custom = interaction.customId;

      // Pong de seguimiento
      if (custom.startsWith('ping_yes:')) {
        const id = custom.split(':')[1];
        db.run(`UPDATE sessions SET pending_ping=0, last_ping_at=? WHERE id=?`, [Date.now(), id]);
        // deshabilitar botones del mensaje
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('x1').setLabel('Sí, sigo en servicio').setStyle(ButtonStyle.Success).setDisabled(true),
          new ButtonBuilder().setCustomId('x2').setLabel('Cerrar ahora').setStyle(ButtonStyle.Danger).setDisabled(true),
        );
        await interaction.update({ content: 'Perfecto, seguimos contando tu servicio 💪', components: [row] }).catch(() => {});
        return;
      }
      if (custom.startsWith('ping_close:')) {
        const id = custom.split(':')[1];
        const fresh = await new Promise(r =>
          db.get(`SELECT * FROM sessions WHERE id=?`, [id], (e2, row) => r(row))
        );
        if (fresh && fresh.status === 'open') {
          await closeSessionCompute(fresh);
          await refreshPanel(fresh.guild_id);
          // disable buttons
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('x1').setLabel('Sí, sigo en servicio').setStyle(ButtonStyle.Success).setDisabled(true),
            new ButtonBuilder().setCustomId('x2').setLabel('Cerrar ahora').setStyle(ButtonStyle.Danger).setDisabled(true),
          );
          await interaction.update({ content: 'Cerrado ✅', components: [row] }).catch(() => {});
        } else {
          await ephemeralAck('La sesión ya no está abierta.');
        }
        return;
      }

      // Entrar
      if (custom === 'bitacora_start') {
        const ok = await openSession(interaction.guildId, interaction.user.id);
        if (!ok) return ephemeralAck('Ya tienes una bitácora abierta.');
        await sendLog(interaction.guildId, `🟢 <@${interaction.user.id}> **entró** en servicio.`);
        await refreshPanel(interaction.guildId);
        return ephemeralAck('Has iniciado tu bitácora — ¡buen servicio! 💖');
      }

      // Salir
      if (custom === 'bitacora_stop') {
        const s = await activeOpenSession(interaction.guildId, interaction.user.id);
        if (!s || s.status === 'closed') return ephemeralAck('No tienes una bitácora abierta.');
        const res = await closeSessionCompute(s);
        const coins = (res.normales / 60) * 1 + (res.estelares / 60) * 2;
        await sendLog(
          interaction.guildId,
          `🔴 <@${interaction.user.id}> **salió**. (+${formatH(res.normales)} normal, +${formatH(res.estelares)} estelar = **${coins.toFixed(
            2
          )} coins**)`
        );
        await refreshPanel(interaction.guildId);
        return ephemeralAck('Cerraste tu bitácora. ¡Gracias por tu servicio! ✨');
      }

      // Pausar
      if (custom === 'bitacora_pause') {
        const s = await activeOpenSession(interaction.guildId, interaction.user.id);
        if (!s || s.status === 'closed') return ephemeralAck('No tienes una bitácora abierta.');
        const ok = await pauseSession(s.id);
        if (!ok) return ephemeralAck('Ya estabas en descanso.');
        db.run(`UPDATE sessions SET status='paused' WHERE id=?`, [s.id]);
        await sendLog(interaction.guildId, `⏸️ <@${interaction.user.id}> **descanso** iniciado.`);
        return ephemeralAck('Descanso iniciado. ⏸️');
      }

      // Reanudar
      if (custom === 'bitacora_resume') {
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
// /bitacora all (handler)
// ------------------------------
function minutesMinusPauses(start, end, pauses) {
  if (!pauses?.length) return Math.max(0, Math.floor((end - start) / 60000));
  let paused = 0;
  for (const p of pauses) {
    const ps = Math.max(start, p.pause_start);
    const pe = Math.min(end, p.pause_end ?? end);
    if (pe > ps) paused += Math.floor((pe - ps) / 60000);
  }
  const total = Math.max(0, Math.floor((end - start) / 60000));
  return Math.max(0, total - paused);
}

async function handleAll(interaction) {
  await interaction.deferReply({ ephemeral: false });

  const guildId = interaction.guildId;

  // Cerradas históricas
  const totals = new Map(); // userId -> { n, e }
  await new Promise(res => {
    db.all(
      `SELECT user_id, SUM(min_normales) AS n, SUM(min_estelares) AS e
       FROM sessions
       WHERE guild_id=?
       GROUP BY user_id`,
      [guildId],
      (e, rows = []) => {
        for (const r of rows) totals.set(r.user_id, { n: r.n || 0, e: r.e || 0 });
        res();
      }
    );
  });

  // Abiertas ahora
  const cfg = await getGuildConfig(guildId);
  const tz = cfg?.timezone || TZ;
  const windows = parseWindows(cfg?.stellar_windows || '00:00-02:00,16:00-18:00');

  const openRows = await new Promise(res =>
    db.all(
      `SELECT id, user_id, start_at FROM sessions WHERE guild_id=? AND status='open'`,
      [guildId],
      (e, rows = []) => res(rows)
    )
  );

  for (const s of openRows) {
    const pauses = await new Promise(res =>
      db.all(`SELECT pause_start, pause_end FROM pauses WHERE session_id=?`, [s.id], (e, r = []) => res(r))
    );
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
    userId,
    n: v.n,
    e: v.e,
    coins: (v.n / 60) * 1 + (v.e / 60) * 2,
  }));
  arr.sort((a, b) => b.coins - a.coins);

  // Paginamos cada 25
  const chunks = [];
  for (let i = 0; i < arr.length; i += 25) chunks.push(arr.slice(i, i + 25));

  const embeds = [];
  let index = 1;
  for (const chunk of chunks) {
    const desc = chunk
      .map(r => `**${index++}.** <@${r.userId}> — ${r.coins.toFixed(2)} coins (Normales ${(r.n/60).toFixed(2)}h · Estelares ${(r.e/60).toFixed(2)}h)`)
      .join('\n');
    embeds.push(new EmbedBuilder().setColor(0xf7a8d8).setTitle('📚 Bitácora — Total histórico (todos)').setDescription(desc || ' '));
  }

  await interaction.editReply({ embeds });
}

// ------------------------------
// Ready
// ------------------------------
client.once('ready', async () => {
  console.log(`Bot listo como ${client.user.tag}`);
  initDb();

  // Al iniciar, intenta refrescar paneles
  for (const g of client.guilds.cache.values()) {
    await refreshPanel(g.id);
  }
});

// ------------------------------
// Login
// ------------------------------
client.login(process.env.DISCORD_TOKEN);

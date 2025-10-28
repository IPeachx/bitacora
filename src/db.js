// src/db.js
import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ruta local por defecto (carpeta raíz del proyecto)
const defaultPath = path.join(__dirname, '..', 'bitacora.db');

// Railway/Producción: usa DB_PATH (monta un volumen en /data y pon DB_PATH=/data/bitacora.db)
export const DB_PATH = process.env.DB_PATH || defaultPath;

// Conexión SQLite
export const db = new sqlite3.Database(DB_PATH);

// Crea tablas/índices si no existen
export function initDb() {
  db.serialize(() => {
    // Config del servidor (canales, horarios, etc.)
    db.run(`CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      panel_channel_id TEXT,
      logs_channel_id  TEXT,
      timezone         TEXT,
      stellar_windows  TEXT,    -- '00:00-02:00,16:00-18:00'
      ping_every_min   INTEGER, -- minutos entre pings (default 120)
      ping_timeout_min INTEGER, -- minutos para autocierre por no responder (default 5)
      offline_afk_min  INTEGER  -- opcional
    )`);

    // Sesiones de bitácora
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id      TEXT NOT NULL,
      user_id       TEXT NOT NULL,
      status        TEXT NOT NULL,      -- 'open' | 'paused' | 'closed'
      start_at      INTEGER NOT NULL,   -- millis
      end_at        INTEGER,            -- millis
      min_normales  INTEGER DEFAULT 0,  -- minutos normales
      min_estelares INTEGER DEFAULT 0,  -- minutos estelares
      last_action_at INTEGER,           -- millis
      last_ping_at   INTEGER,           -- millis
      pending_ping   INTEGER DEFAULT 0, -- 1 si hay ping sin responder
      reason         TEXT               -- razón de cierre opcional
    )`);

    // Pausas por sesión
    db.run(`CREATE TABLE IF NOT EXISTS pauses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  INTEGER NOT NULL,
      pause_start INTEGER NOT NULL,  -- millis
      pause_end   INTEGER            -- millis (NULL si sigue en pausa)
    )`);

    // Ajustes manuales (sumar/restar minutos)
    db.run(`CREATE TABLE IF NOT EXISTS adjustments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      minutes    INTEGER NOT NULL,  -- puede ser negativo
      reason     TEXT,
      staff_id   TEXT,
      created_at INTEGER NOT NULL   -- millis
    )`);

    // Historial semanal (post-backup de los viernes)
    db.run(`CREATE TABLE IF NOT EXISTS sessions_history (
      id            INTEGER,
      guild_id      TEXT,
      user_id       TEXT,
      status        TEXT,
      start_at      INTEGER,
      end_at        INTEGER,
      min_normales  INTEGER,
      min_estelares INTEGER,
      last_action_at INTEGER,
      last_ping_at   INTEGER,
      pending_ping   INTEGER,
      reason         TEXT,
      archived_at    INTEGER           -- millis (momento del archivado)
    )`);

    // Índices útiles
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_guild_user ON sessions(guild_id, user_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_guild_status ON sessions(guild_id, status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_pauses_session ON pauses(session_id)`);
  });
}

// Helpers para leer/guardar config del servidor
export function getGuildConfig(guild_id, cb) {
  db.get(`SELECT * FROM guild_config WHERE guild_id=?`, [guild_id], (err, row) => cb(err, row));
}

export function upsertGuildConfig(cfg, cb) {
  // upsert simple: si existe, UPDATE; si no, INSERT
  db.get(`SELECT guild_id FROM guild_config WHERE guild_id=?`, [cfg.guild_id], (e, row) => {
    if (e) return cb?.(e);
    const data = {
      panel_channel_id: cfg.panel_channel_id ?? null,
      logs_channel_id:  cfg.logs_channel_id ?? null,
      timezone:         cfg.timezone ?? 'America/Mexico_City',
      stellar_windows:  cfg.stellar_windows ?? '00:00-02:00,16:00-18:00',
      ping_every_min:   cfg.ping_every_min ?? 120,
      ping_timeout_min: cfg.ping_timeout_min ?? 5,
      offline_afk_min:  cfg.offline_afk_min ?? 30,
    };
    if (row) {
      db.run(
        `UPDATE guild_config SET
           panel_channel_id=?,
           logs_channel_id=?,
           timezone=?,
           stellar_windows=?,
           ping_every_min=?,
           ping_timeout_min=?,
           offline_afk_min=?
         WHERE guild_id=?`,
        [
          data.panel_channel_id,
          data.logs_channel_id,
          data.timezone,
          data.stellar_windows,
          data.ping_every_min,
          data.ping_timeout_min,
          data.offline_afk_min,
          cfg.guild_id,
        ],
        cb
      );
    } else {
      db.run(
        `INSERT INTO guild_config (
           guild_id, panel_channel_id, logs_channel_id, timezone, stellar_windows,
           ping_every_min, ping_timeout_min, offline_afk_min
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cfg.guild_id,
          data.panel_channel_id,
          data.logs_channel_id,
          data.timezone,
          data.stellar_windows,
          data.ping_every_min,
          data.ping_timeout_min,
          data.offline_afk_min,
        ],
        cb
      );
    }
  });
}

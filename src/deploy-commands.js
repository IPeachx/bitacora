// src/deploy-commands.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, ChannelType } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('bitacora')
    .setDescription('Comandos de la bitácora')
    // /bitacora panel
    .addSubcommand(sc =>
      sc
        .setName('panel')
        .setDescription('Publica el panel en un canal')
        .addChannelOption(o =>
          o
            .setName('canal')
            .setDescription('Canal destino')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
    )
    // /bitacora config
    .addSubcommand(sc =>
      sc
        .setName('config')
        .setDescription('Configura opciones básicas')
        .addChannelOption(o =>
          o
            .setName('canal_logs')
            .setDescription('Canal de logs')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addIntegerOption(o =>
          o
            .setName('ping_cada_min')
            .setDescription('Minutos entre pings (default 120)')
            .setRequired(false)
        )
        .addIntegerOption(o =>
          o
            .setName('ping_timeout_min')
            .setDescription('Minutos para autocierre si no responde (default 5)')
            .setRequired(false)
        )
        .addIntegerOption(o =>
          o
            .setName('offline_afk_min')
            .setDescription('Min offline para ping extra (default 30)')
            .setRequired(false)
        )
    )
    // /bitacora sumar
    .addSubcommand(sc =>
      sc
        .setName('sumar')
        .setDescription('Suma minutos a un usuario')
        .addUserOption(o =>
          o.setName('usuario').setDescription('Usuario').setRequired(true)
        )
        .addIntegerOption(o =>
          o
            .setName('minutos')
            .setDescription('Minutos a sumar')
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName('motivo').setDescription('Motivo').setRequired(true)
        )
    )
    // /bitacora restar
    .addSubcommand(sc =>
      sc
        .setName('restar')
        .setDescription('Resta minutos a un usuario')
        .addUserOption(o =>
          o.setName('usuario').setDescription('Usuario').setRequired(true)
        )
        .addIntegerOption(o =>
          o
            .setName('minutos')
            .setDescription('Minutos a restar')
            .setRequired(true)
        )
        .addStringOption(o =>
          o.setName('motivo').setDescription('Motivo').setRequired(true)
        )
    )
    // /bitacora forzar_cierre
    .addSubcommand(sc =>
      sc
        .setName('forzar_cierre')
        .setDescription('Forzar cierre de sesión activa')
        .addUserOption(o =>
          o.setName('usuario').setDescription('Usuario').setRequired(true)
        )
    )
    // /bitacora top
    .addSubcommand(sc =>
      sc
        .setName('top')
        .setDescription('Muestra el top por periodo')
        .addStringOption(o =>
          o
            .setName('periodo')
            .setDescription('hoy | semana | mes')
            .setRequired(true)
            .addChoices(
              { name: 'hoy', value: 'hoy' },
              { name: 'semana', value: 'semana' },
              { name: 'mes', value: 'mes' }
            )
        )
    )
    // /bitacora all  ← NUEVO
    .addSubcommand(sc =>
      sc
        .setName('all')
        .setDescription(
          'Muestra TODAS las horas históricas de TODOS los usuarios (normales, estelares y coins).'
        )
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  try {
    const clientId = process.env.CLIENT_ID;
    const guildId = process.env.GUILD_ID;
    if (!clientId) throw new Error('CLIENT_ID faltante');
    if (!guildId) throw new Error('GUILD_ID faltante para deploy local');
    const r = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands }
    );
    console.log('✅ Comandos registrados:', Array.isArray(r) ? r.length : r);
  } catch (e) {
    console.error('❌ Error registrando comandos:', e);
  }
}
main();


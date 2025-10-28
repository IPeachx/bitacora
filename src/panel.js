import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { db, getGuildConfig } from './db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function renderPanel(guild, channel) {
  return new Promise((resolve, reject) => {
    getGuildConfig(guild.id, async (err, cfg) => {
      if (err) return reject(err);
      const timezone = cfg?.timezone || 'America/Mexico_City';

      // Fetch open sessions
      db.all(`SELECT user_id FROM sessions WHERE guild_id=? AND status='open'`, [guild.id], async (e2, rows) => {
        if (e2) return reject(e2);
        const tags = rows?.slice(0, 20).map(r => `<@${r.user_id}>`) || [];
        const extra = rows && rows.length > 20 ? ` +${rows.length-20} más…` : '';

        const attachment = new AttachmentBuilder(path.join(__dirname, '..', 'assets', 'lollipop-bitacora.png'));
        const embed = new EmbedBuilder()
          .setColor(0xF7A8D8)
          .setAuthor({ name: 'Lollipop Bitácora', iconURL: 'attachment://lollipop-bitacora.png' })
          .setTitle('Bitácora de Servicio')
          .setDescription([
            'Usa los botones para **Entrar/Salir** o **Descanso/Reanudar**.',
            '• Horas estelares diarias: **4–6 PM** y **12–2 AM**',
            `• Zona horaria: **${timezone}**`,
            '',
            `**En servicio ahora:** ${tags.length ? tags.join(' ') + extra : '—'}`
          ].join('\n'))
          .setFooter({ text: 'Tarifa: 1 coin/h normal · 2 coins/h estelar' });

        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('bitacora_entrar').setLabel('Entrar').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId('bitacora_salir').setLabel('Salir').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('bitacora_descanso').setLabel('Descanso').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('bitacora_reanudar').setLabel('Reanudar').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('bitacora_lista').setLabel('📋 Bitácora').setStyle(ButtonStyle.Secondary)
        );

        const msg = await channel.send({ embeds: [embed], components: [row1], files: [attachment] });
        resolve(msg);
      });
    });
  });
}

export async function updatePanelMessage(message) {
  // Optional: For future updates we could edit the message instead of sending a new one.
  // For simplicity in this v1 we will send a new panel on command and let old ones be deleted by admins if needed.
}

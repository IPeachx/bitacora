# Lollipop Bitácora Bot

Bot de Bitácora para tu servidor Lollipop (Discord.js v14 + SQLite).

## Características
- Panel con botones: **Entrar**, **Salir**, **Descanso**, **Reanudar**, **📋 Bitácora**
- Horas estelares diarias: **4–6 PM** y **12–2 AM** (CDMX) — cuentan **2 coins/h**
- Horas normales cuentan **1 coin/h**
- Pings automáticos cada 2h para confirmar servicio; **autocierre** si no responden (5 min)
- Lista/Top por periodo (hoy/semana/mes) mostrando coins
- Ajustes manuales: sumar/restar minutos con auditoría
- Logs en canal staff
- Zona horaria fija: **America/Mexico_City**

## Requisitos
- Node.js 18+
- Un bot de Discord (TOKEN, CLIENT_ID) y un servidor para pruebas

## Instalación
```bash
npm i
cp .env.example .env
# Edita .env con tus IDs
npm run deploy   # registra los comandos en tu GUILD_ID
npm start
```

## Uso rápido
- `/bitacora panel canal:#tu-canal` → publica el panel
- `/bitacora config canal_logs:#logs` → setea el canal de logs y/o tiempos
- Botones del panel para operar
- `/bitacora top periodo:hoy|semana|mes`
- `/bitacora sumar|restar` para ajustes con motivo

## Notas
- El panel usa `assets/lollipop-bitacora.png` como mini-logo (se muestra en el author del embed).
- La DB es `bitacora.db` en la raíz del proyecto.
- Si quieres cambiar ventanas estelares, edita `config` en la DB o ajusta el código según tu preferencia.

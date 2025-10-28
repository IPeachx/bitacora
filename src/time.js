import { DateTime, Interval } from 'luxon';

// Parse 'HH:mm-HH:mm,HH:mm-HH:mm' => array of [start,end] (minutes since 00:00)
export function parseWindows(stellarWindowsStr) {
  const parts = stellarWindowsStr.split(',').map(s => s.trim());
  const win = [];
  for (const p of parts) {
    const [a, b] = p.split('-').map(x => x.trim());
    const [h1, m1] = a.split(':').map(Number);
    const [h2, m2] = b.split(':').map(Number);
    win.push([h1*60 + m1, h2*60 + m2]);
  }
  return win;
}

// Given start, end (epoch ms), timezone, and windows (minutes since 00:00), return {normales, estelares}
export function splitMinutesByWindows(startMs, endMs, timezone, windows) {
  if (endMs <= startMs) return { normales: 0, estelares: 0 };
  let normales = 0;
  let estelares = 0;

  // Work day by day across local TZ
  let cursor = DateTime.fromMillis(startMs, { zone: timezone });
  const end = DateTime.fromMillis(endMs, { zone: timezone });

  while (cursor < end) {
    const dayStart = cursor.startOf('day');
    const dayEnd = dayStart.plus({ days: 1 });
    const rangeEnd = end < dayEnd ? end : dayEnd;

    // Session segment [cursor, rangeEnd)
    const seg = Interval.fromDateTimes(cursor, rangeEnd);
    const segMinutes = Math.floor(seg.length('minutes'));
    if (segMinutes <= 0) { cursor = rangeEnd; continue; }

    // For this local day, compute overlap with each stellar window
    let estForDay = 0;
    for (const [wStartMin, wEndMin] of windows) {
      const wStart = dayStart.plus({ minutes: wStartMin });
      const wEnd = dayStart.plus({ minutes: wEndMin });
      const winInterval = Interval.fromDateTimes(wStart, wEnd);
      const overlap = seg.intersection(winInterval);
      if (overlap) {
        estForDay += Math.floor(overlap.length('minutes'));
      }
    }
    estelares += estForDay;
    normales += segMinutes - estForDay;
    cursor = rangeEnd;
  }
  return { normales, estelares };
}

export function minutesToCoins(normales, estelares) {
  const coins = (normales/60) * 1 + (estelares/60) * 2;
  return Math.round(coins * 100) / 100; // 2 decimales (banca)
}

import { differenceInCalendarDays, format, formatDistanceStrict } from 'date-fns';

/** "2 h 05 min", "45 min", "under 1 min" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const mins = Math.round(seconds / 60);
  if (mins < 1) return 'under 1 min';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${String(m).padStart(2, '0')} min` : `${h} h`;
}

/** "in 2 h", "5 min ago" — compact relative time. */
export function relative(date: Date | string, now: number = Date.now()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diff = d.getTime() - now;
  if (Math.abs(diff) < 45_000) return diff >= 0 ? 'now' : 'just now';
  const s = formatDistanceStrict(d, now, { roundingMethod: 'round' })
    .replace(/ hours?/, ' h')
    .replace(/ minutes?/, ' min')
    .replace(/ seconds?/, ' s')
    .replace(/ days?/, (m) => (m.trim() === 'day' ? ' day' : ' days'));
  return diff >= 0 ? `in ${s}` : `${s} ago`;
}

/** Local clock time with a day word when it isn't today: "23:00", "Tomorrow 07:00", "Mon 12 Jan 09:30". */
export function clockTime(date: Date | string, now: number = Date.now()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const days = differenceInCalendarDays(d, now);
  const t = format(d, 'p');
  if (days === 0) return t;
  if (days === 1) return `Tomorrow ${t}`;
  if (days === -1) return `Yesterday ${t}`;
  if (days > 1 && days < 7) return `${format(d, 'EEE')} ${t}`;
  return `${format(d, 'EEE d MMM')} ${t}`;
}

/** Full exact local time, for tooltips. */
export function exactTime(date: Date | string): string {
  return format(typeof date === 'string' ? new Date(date) : date, "EEEE d MMMM yyyy, p (O)");
}

/** "02:14:09" countdown. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h >= 24 ? `${Math.floor(h / 24)}d ${pad(h % 24)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** "Benchy.gcode.3mf" -> "Benchy" */
export function displayName(name: string): string {
  return name.replace(/^sched_[0-9a-f]{8}_/i, '').replace(/(\.gcode)?\.3mf$/i, '');
}

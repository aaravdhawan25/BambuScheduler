import { addDays, addHours, setHours, startOfHour, startOfMinute } from 'date-fns';
import type { Job } from './types';

export interface QuickChip {
  id: 'now' | '1h' | 'tonight' | 'morning';
  label: string;
  at: Date;
}

/** Quick schedule options, computed in the browser's local time zone. */
export function quickChips(now: Date = new Date()): QuickChip[] {
  let tonight = startOfHour(setHours(now, 23));
  if (tonight.getTime() <= now.getTime()) tonight = addDays(tonight, 1);
  const morning = startOfHour(setHours(addDays(now, 1), 7));
  return [
    { id: 'now', label: 'Now', at: now },
    { id: '1h', label: 'In 1 hour', at: startOfMinute(addHours(now, 1)) },
    { id: 'tonight', label: tonight.getDate() === now.getDate() ? 'Tonight 11 pm' : 'Tomorrow 11 pm', at: tonight },
    { id: 'morning', label: 'Tomorrow 7 am', at: morning },
  ];
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v); // parsed as local time
  return Number.isNaN(d.getTime()) ? null : d;
}

const DEFAULT_EST_S = 3600;

export interface Window {
  start: number;
  end: number;
}

/** When a job is expected to occupy the printer. Uses real start/finish where known. */
export function jobWindow(job: Job, now: number = Date.now()): Window {
  const est = (job.est_seconds ?? DEFAULT_EST_S) * 1000;
  if (job.started_at) {
    const start = Date.parse(job.started_at);
    const end = job.finished_at ? Date.parse(job.finished_at) : Math.max(start + est, now);
    return { start, end };
  }
  const start = Math.max(Date.parse(job.run_at), job.stage === 'pending' ? now : 0);
  return { start, end: start + est };
}

export function estimatedFinish(runAt: Date, estSeconds: number | null, now: number = Date.now()): Date {
  const start = Math.max(runAt.getTime(), now);
  return new Date(start + (estSeconds ?? DEFAULT_EST_S) * 1000);
}

/** Upcoming/active jobs whose window overlaps [start, end). */
export function overlappingJobs(
  jobs: Job[],
  start: Date,
  estSeconds: number | null,
  excludeId?: string,
  now: number = Date.now(),
): Job[] {
  const s = Math.max(start.getTime(), now);
  const e = s + (estSeconds ?? DEFAULT_EST_S) * 1000;
  return jobs.filter((j) => {
    if (j.id === excludeId) return false;
    if (!['pending', 'uploading', 'printing'].includes(j.stage)) return false;
    const w = jobWindow(j, now);
    return w.start < e && s < w.end;
  });
}

export type ScheduleChoice = { kind: 'now' } | { kind: 'at'; at: Date; chip?: string };

export function resolveChoice(c: ScheduleChoice): Date {
  return c.kind === 'now' ? new Date() : c.at;
}

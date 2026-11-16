import type { HubStatus, Job, Stage } from './types';

export const HUB_OFFLINE_AFTER_MS = 45_000;

export function isHubOnline(hub: HubStatus | null | undefined, now: number): boolean {
  if (!hub?.last_seen) return false;
  return now - Date.parse(hub.last_seen) < HUB_OFFLINE_AFTER_MS;
}

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface Badge {
  label: string;
  tone: Tone;
  /** Short text marker so status never relies on colour alone. */
  icon: 'idle' | 'prepare' | 'print' | 'pause' | 'done' | 'error' | 'offline' | 'clock' | 'upload' | 'plate' | 'cancel' | 'missed';
}

export function printerBadge(hub: HubStatus | null | undefined, online: boolean): Badge {
  if (!online) return { label: 'Hub offline', tone: 'neutral', icon: 'offline' };
  if (!hub?.connected) return { label: 'Printer offline', tone: 'neutral', icon: 'offline' };
  switch (hub.state) {
    case 'IDLE':
      return { label: 'Idle', tone: 'neutral', icon: 'idle' };
    case 'PREPARE':
    case 'SLICING':
      return { label: 'Preparing', tone: 'info', icon: 'prepare' };
    case 'RUNNING':
      return { label: 'Printing', tone: 'accent', icon: 'print' };
    case 'PAUSE':
      return { label: 'Paused', tone: 'warning', icon: 'pause' };
    case 'FINISH':
      return { label: 'Finished', tone: 'success', icon: 'done' };
    case 'FAILED':
      return { label: 'Error', tone: 'danger', icon: 'error' };
    default:
      return { label: hub.state ? String(hub.state).toLowerCase() : 'Unknown', tone: 'neutral', icon: 'idle' };
  }
}

export const STAGE_BADGE: Record<Stage, Badge> = {
  pending: { label: 'Scheduled', tone: 'info', icon: 'clock' },
  uploading: { label: 'Sending', tone: 'info', icon: 'upload' },
  printing: { label: 'Printing', tone: 'accent', icon: 'print' },
  awaiting_clear: { label: 'Clear plate', tone: 'warning', icon: 'plate' },
  attention: { label: 'Needs attention', tone: 'danger', icon: 'error' },
  done: { label: 'Done', tone: 'success', icon: 'done' },
  cancelled: { label: 'Cancelled', tone: 'neutral', icon: 'cancel' },
  missed: { label: 'Missed', tone: 'warning', icon: 'missed' },
};

export function isPrinterBusy(hub: HubStatus | null | undefined): boolean {
  return !!hub && ['PREPARE', 'RUNNING', 'PAUSE', 'SLICING'].includes(String(hub.state));
}

/** Next pending job by run time (due or upcoming). */
export function nextPendingJob(jobs: Job[]): Job | null {
  return (
    jobs
      .filter((j) => j.stage === 'pending')
      .sort((a, b) => a.run_at.localeCompare(b.run_at))[0] ?? null
  );
}

export function activeJob(jobs: Job[], hub: HubStatus | null | undefined): Job | null {
  if (hub?.active_job_id) {
    const j = jobs.find((x) => x.id === hub.active_job_id);
    if (j) return j;
  }
  return jobs.find((j) => ['uploading', 'printing', 'awaiting_clear', 'attention'].includes(j.stage)) ?? null;
}

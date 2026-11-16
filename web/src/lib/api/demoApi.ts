/**
 * In-browser demo backend with a simulated hub and printer.
 *
 * Used when VITE_DEMO=1 or Supabase env vars are missing, and by Playwright.
 * Follows the same rules as the real hub (plate interlock, missed jobs,
 * commands), with time compressed: a 1-hour print takes about 1 minute.
 */
import type {
  Command,
  CommandAction,
  HubStatus,
  Job,
  JobPatch,
  NewJobInput,
  Settings,
} from '../types';
import { FriendlyError, MAX_UPLOAD_BYTES, type Api, type ChangeEvent, type Role, type SessionInfo } from './api';

const DEMO_USER: SessionInfo = { userId: '00000000-0000-4000-8000-000000000001', email: 'demo@example.com' };
const SESSION_KEY = 'demo-session';
const PREPARE_S = 6;

const iso = (d: Date | number) => new Date(d).toISOString();

function thumbSvg(hue: number, shape: 'boat' | 'gear' | 'box' | 'vase'): string {
  const fill = `hsl(${hue} 70% 55%)`;
  const shapes = {
    boat: `<path d="M18 62h64l-10 16H30z" fill="${fill}"/><rect x="44" y="26" width="18" height="30" rx="3" fill="${fill}" opacity=".8"/><rect x="30" y="44" width="40" height="14" rx="3" fill="${fill}" opacity=".9"/>`,
    gear: `<circle cx="50" cy="50" r="22" fill="none" stroke="${fill}" stroke-width="12" stroke-dasharray="9 5"/><circle cx="50" cy="50" r="9" fill="${fill}"/>`,
    box: `<path d="M50 20 80 35v32L50 82 20 67V35z" fill="${fill}" opacity=".85"/><path d="M50 20 80 35 50 50 20 35z" fill="${fill}"/>`,
    vase: `<path d="M38 20h24c-2 10 10 18 10 34 0 16-10 26-22 26S28 70 28 54c0-16 12-24 10-34z" fill="${fill}"/>`,
  }[shape];
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1d2127"/>${shapes}</svg>`,
  )}`;
}

function baseJob(over: Partial<Job> & Pick<Job, 'name'>): Job {
  const id = over.id ?? crypto.randomUUID();
  return {
    id,
    owner_id: DEMO_USER.userId,
    storage_path: `${DEMO_USER.userId}/${id}/${over.name}`,
    thumb_path: null,
    file_size: 2_400_000,
    run_at: iso(Date.now()),
    use_ams: false,
    ams_mapping: [],
    stage: 'pending',
    note: null,
    est_seconds: 3600,
    filament_g: 20,
    filament_type: 'PLA',
    remote_name: null,
    created_at: iso(Date.now()),
    started_at: null,
    finished_at: null,
    file_purged_at: null,
    updated_at: iso(Date.now()),
    ...over,
  };
}

function seedJobs(now: number): Job[] {
  const h = 3600_000;
  const tonight = new Date(now);
  tonight.setHours(23, 0, 0, 0);
  if (tonight.getTime() < now + h) tonight.setDate(tonight.getDate() + 1);
  const tomorrow7 = new Date(now);
  tomorrow7.setDate(tomorrow7.getDate() + 1);
  tomorrow7.setHours(7, 0, 0, 0);
  return [
    baseJob({ name: 'Cable clips x12.gcode.3mf', thumb_path: thumbSvg(200, 'gear'), run_at: iso(tonight), est_seconds: 2.5 * 3600, filament_g: 34 }),
    baseJob({ name: 'Desk organiser.gcode.3mf', thumb_path: thumbSvg(30, 'box'), run_at: iso(tomorrow7), est_seconds: 5 * 3600, filament_g: 112, use_ams: true, ams_mapping: [0, 2], filament_type: 'PLA, PETG' }),
    baseJob({ name: 'Benchy.gcode.3mf', thumb_path: thumbSvg(150, 'boat'), stage: 'done', run_at: iso(now - 26 * h), created_at: iso(now - 27 * h), started_at: iso(now - 26 * h), finished_at: iso(now - 25 * h), est_seconds: 3000, filament_g: 12 }),
    baseJob({ name: 'Spiral vase.gcode.3mf', thumb_path: thumbSvg(280, 'vase'), stage: 'done', run_at: iso(now - 50 * h), created_at: iso(now - 52 * h), started_at: iso(now - 50 * h), finished_at: iso(now - 47 * h), est_seconds: 3 * 3600, filament_g: 41, file_purged_at: iso(now - 2 * h) }),
    baseJob({ name: 'Hinge test.gcode.3mf', thumb_path: thumbSvg(0, 'gear'), stage: 'missed', run_at: iso(now - 75 * h), created_at: iso(now - 80 * h), finished_at: iso(now - 74 * h), note: "Didn't start within 60 min of its scheduled time (Waiting for plate to be cleared)." }),
    baseJob({ name: 'Phone stand.gcode.3mf', thumb_path: thumbSvg(90, 'box'), stage: 'cancelled', run_at: iso(now - 100 * h), created_at: iso(now - 101 * h), finished_at: iso(now - 100.5 * h) }),
  ];
}

interface Run {
  jobId: string;
  started: number;
  printS: number;
  pausedAt: number | null;
  pausedTotal: number;
}

export class DemoApi implements Api {
  readonly mode = 'demo' as const;
  private jobs: Job[];
  private commands: Command[] = [];
  private settings: Settings = { id: 1, max_late_min: 60, auto_continue: false, ntfy_topic: null, updated_at: iso(Date.now()) };
  private hub: HubStatus;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private authListeners = new Set<(s: SessionInfo | null) => void>();
  private printerState: string = 'IDLE';
  private subtask = '';
  private run: Run | null = null;
  private stopRequested = false;
  private online = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private blobUrls = new Map<string, string>();
  private fileBlobs = new Map<string, Blob>();

  constructor() {
    const now = Date.now();
    this.jobs = seedJobs(now);
    this.hub = {
      id: 1, last_seen: iso(now), hub_version: '0.1.0-demo', last_error: null, plate_clear: true,
      waiting_reason: null, active_job_id: null, connected: true, state: 'IDLE', progress: 0,
      remaining_min: null, nozzle: 27, bed: 25, file: null, updated_at: iso(now),
    };
    this.timer = setInterval(() => this.tick(), 1000);
    if (typeof window !== 'undefined') {
      (window as unknown as { __demo: unknown }).__demo = {
        setHubOnline: (v: boolean) => {
          this.online = v;
          if (!v) {
            this.hub.last_seen = iso(Date.now() - 60_000);
            this.emitHub();
          }
        },
        finishNow: () => { if (this.run) this.run.started = Date.now() - (PREPARE_S + this.run.printS) * 1000; this.tick(); },
        failNow: () => { this.run = null; this.printerState = 'FAILED'; this.tick(); },
        setPlateClear: (v: boolean) => { this.hub.plate_clear = v; this.emitHub(); },
        api: this,
      };
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --- auth -----------------------------------------------------------------

  async getSession(): Promise<SessionInfo | null> {
    try {
      return sessionStorage.getItem(SESSION_KEY) ? DEMO_USER : null;
    } catch {
      return null;
    }
  }
  onAuthChange(cb: (s: SessionInfo | null) => void): () => void {
    this.authListeners.add(cb);
    return () => this.authListeners.delete(cb);
  }
  async signIn(email: string, password: string): Promise<void> {
    await delay(400);
    if (!email || password.length < 4) throw new FriendlyError("That email and password don't match. (Demo: any email, 4+ character password.)");
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* private mode */ }
    this.authListeners.forEach((l) => l(DEMO_USER));
  }
  async sendMagicLink(): Promise<void> {
    await delay(400);
  }
  async signOut(): Promise<void> {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    this.authListeners.forEach((l) => l(null));
  }
  async myRole(): Promise<Role> {
    return 'owner';
  }

  // --- reads ----------------------------------------------------------------

  async listJobs(): Promise<Job[]> {
    await delay(250);
    return [...this.jobs].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((j) => ({ ...j }));
  }
  async getHubStatus(): Promise<HubStatus | null> {
    await delay(150);
    return { ...this.hub };
  }
  async getSettings(): Promise<Settings | null> {
    await delay(100);
    return { ...this.settings };
  }
  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    await delay(200);
    if (patch.ntfy_topic && !/^[A-Za-z0-9_-]{1,64}$/.test(patch.ntfy_topic)) {
      throw new FriendlyError('Topic can only use letters, numbers, - and _ (max 64).');
    }
    this.settings = { ...this.settings, ...patch, updated_at: iso(Date.now()) };
    this.emit({ table: 'settings', row: { ...this.settings } });
    return { ...this.settings };
  }

  // --- jobs -----------------------------------------------------------------

  async createJob(input: NewJobInput, onProgress?: (f: number) => void): Promise<Job> {
    if (input.file.size > MAX_UPLOAD_BYTES) {
      throw new FriendlyError(`That file is ${(input.file.size / 1048576).toFixed(0)} MB; the limit is 50 MB.`);
    }
    for (let i = 1; i <= 10; i++) {
      await delay(80);
      onProgress?.(i / 10);
    }
    let thumb: string | null = null;
    if (input.thumbnail) {
      thumb = URL.createObjectURL(input.thumbnail);
      this.blobUrls.set(input.id, thumb);
    }
    const job = baseJob({
      id: input.id, name: input.name, thumb_path: thumb, file_size: input.file.size,
      run_at: input.runAt.toISOString(), use_ams: input.useAms, ams_mapping: input.amsMapping,
      est_seconds: input.estSeconds, filament_g: input.filamentG, filament_type: input.filamentType,
    });
    this.fileBlobs.set(job.id, input.file);
    this.jobs.push(job);
    this.emit({ table: 'jobs', type: 'INSERT', row: { ...job } });
    return { ...job };
  }

  async reprintJob(job: Job, runAt: Date): Promise<Job> {
    await delay(300);
    if (job.file_purged_at) throw new FriendlyError('That file was cleaned up. Upload it again.');
    const copy = baseJob({
      name: job.name, thumb_path: job.thumb_path, file_size: job.file_size, run_at: runAt.toISOString(),
      use_ams: job.use_ams, ams_mapping: job.ams_mapping, est_seconds: job.est_seconds,
      filament_g: job.filament_g, filament_type: job.filament_type,
    });
    this.jobs.push(copy);
    this.emit({ table: 'jobs', type: 'INSERT', row: { ...copy } });
    return { ...copy };
  }

  async updateJob(id: string, patch: JobPatch): Promise<Job> {
    await delay(200);
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new FriendlyError('That print no longer exists.');
    if (patch.stage === 'cancelled') {
      if (job.stage !== 'pending' && job.stage !== 'attention') {
        throw new FriendlyError("That job has already moved on, so it can't be changed.");
      }
    } else if (job.stage !== 'pending') {
      throw new FriendlyError("Only jobs that haven't started can be changed.");
    }
    Object.assign(job, patch, { updated_at: iso(Date.now()) });
    if (patch.stage === 'cancelled') job.finished_at = iso(Date.now());
    this.emit({ table: 'jobs', type: 'UPDATE', row: { ...job } });
    return { ...job };
  }

  async deleteJob(id: string): Promise<void> {
    await delay(200);
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !['done', 'cancelled', 'missed'].includes(job.stage)) {
      throw new FriendlyError("Only finished prints can be deleted.");
    }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emit({ table: 'jobs', type: 'DELETE', id });
  }

  async sendCommand(action: CommandAction, jobId: string | null = null): Promise<Command> {
    await delay(150);
    const cmd: Command = {
      id: this.commands.length + 1, action, status: 'pending', job_id: jobId,
      created_by: DEMO_USER.userId, created_at: iso(Date.now()), handled_at: null, result: null,
    };
    this.commands.push(cmd);
    this.emit({ table: 'commands', type: 'INSERT', row: { ...cmd } });
    return { ...cmd };
  }

  async thumbnailUrl(path: string): Promise<string | null> {
    return path;
  }

  subscribe(onChange: (e: ChangeEvent) => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  // --- simulated hub ----------------------------------------------------------

  private emit(e: ChangeEvent) {
    this.listeners.forEach((l) => l(e));
  }
  private emitHub() {
    this.hub.updated_at = iso(Date.now());
    this.emit({ table: 'hub_status', row: { ...this.hub } });
  }
  private setStage(job: Job, stage: Job['stage'], extra: Partial<Job> = {}) {
    Object.assign(job, { stage, updated_at: iso(Date.now()) }, extra);
    if (['done', 'cancelled', 'missed'].includes(stage) && !job.finished_at) job.finished_at = iso(Date.now());
    this.emit({ table: 'jobs', type: 'UPDATE', row: { ...job } });
  }
  private finishCommand(cmd: Command, status: 'done' | 'failed', result: string) {
    Object.assign(cmd, { status, result, handled_at: iso(Date.now()) });
    this.emit({ table: 'commands', type: 'UPDATE', row: { ...cmd } });
  }

  private phase(): string {
    const r = this.run;
    if (!r) return this.printerState;
    if (r.pausedAt) return 'PAUSE';
    const el = (Date.now() - r.started - r.pausedTotal) / 1000;
    if (el < PREPARE_S) return 'PREPARE';
    if (el < PREPARE_S + r.printS) return 'RUNNING';
    this.run = null;
    this.printerState = 'FINISH';
    return 'FINISH';
  }

  private tick() {
    if (!this.online) return;
    const now = Date.now();
    const runBefore = this.run;
    const state = this.phase();

    // commands
    for (const cmd of this.commands.filter((c) => c.status === 'pending' && now - Date.parse(c.created_at) > 600)) {
      const active = ['PREPARE', 'RUNNING', 'PAUSE'].includes(state);
      if (cmd.action === 'pause') {
        if (state === 'RUNNING' && this.run) { this.run.pausedAt = now; this.finishCommand(cmd, 'done', 'Paused.'); }
        else this.finishCommand(cmd, 'failed', `Nothing to pause (printer is ${state.toLowerCase()}).`);
      } else if (cmd.action === 'resume') {
        if (state === 'PAUSE' && this.run?.pausedAt) {
          this.run.pausedTotal += now - this.run.pausedAt;
          this.run.pausedAt = null;
          this.finishCommand(cmd, 'done', 'Resumed.');
        } else this.finishCommand(cmd, 'failed', `Nothing to resume (printer is ${state.toLowerCase()}).`);
      } else if (cmd.action === 'stop') {
        if (active) { this.run = null; this.printerState = 'FAILED'; this.stopRequested = true; this.finishCommand(cmd, 'done', 'Stopped.'); }
        else this.finishCommand(cmd, 'failed', `Nothing to stop (printer is ${state.toLowerCase()}).`);
      } else if (cmd.action === 'plate_clear') {
        if (active) { this.finishCommand(cmd, 'failed', "The printer is still printing; the plate can't be clear yet."); continue; }
        let closed = 0;
        for (const j of this.jobs.filter((j) => j.stage === 'awaiting_clear' || j.stage === 'attention')) {
          this.setStage(j, 'done');
          closed++;
        }
        this.hub.plate_clear = true;
        this.finishCommand(cmd, 'done', 'Plate marked clear.' + (closed ? ` Closed ${closed} job(s).` : ''));
      }
    }

    // printing job
    const printing = this.jobs.find((j) => j.stage === 'printing');
    const st = this.phase();
    if (printing) {
      if (st === 'FINISH' && runBefore) {
        if (this.settings.auto_continue) { this.setStage(printing, 'done'); this.hub.plate_clear = true; }
        else { this.setStage(printing, 'awaiting_clear', { finished_at: iso(now) }); this.hub.plate_clear = false; }
      } else if (st === 'FAILED' || st === 'IDLE') {
        this.setStage(printing, 'attention', {
          note: this.stopRequested ? 'Stopped from the app. Clear the plate before the next print.' : 'The printer reported a failed print. Check the printer.',
        });
        this.stopRequested = false;
        this.hub.plate_clear = false;
      }
    }

    // start due jobs
    let waiting: string | null = null;
    const due = this.jobs.filter((j) => j.stage === 'pending' && Date.parse(j.run_at) <= now).sort((a, b) => a.run_at.localeCompare(b.run_at));
    if (due.length) {
      const busy = this.jobs.filter((j) => ['uploading', 'printing', 'awaiting_clear'].includes(j.stage));
      let blocker: string | null = null;
      if (this.jobs.some((j) => j.stage === 'attention')) blocker = 'A print needs attention';
      else if (busy.some((j) => j.stage === 'awaiting_clear')) blocker = 'Waiting for plate to be cleared';
      else if (busy.length) blocker = 'Another print is in progress';
      else if (!this.hub.plate_clear) blocker = 'Waiting for plate to be cleared';
      else if (!['IDLE', 'FINISH', 'FAILED'].includes(this.phase())) blocker = `Printer is busy (${this.phase().toLowerCase()})`;
      const startable = due.filter((j) => {
        if (now - Date.parse(j.run_at) > this.settings.max_late_min * 60_000) {
          this.setStage(j, 'missed', { note: `Didn't start within ${this.settings.max_late_min} min of its scheduled time${blocker ? ` (${blocker})` : ''}.` });
          return false;
        }
        return true;
      });
      if (startable.length) {
        if (blocker) waiting = blocker;
        else {
          const job = startable[0];
          this.hub.plate_clear = false;
          const remote = `sched_${job.id.replace(/-/g, '').slice(0, 8)}_${job.name.replace(/(\.gcode)?\.3mf$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_')}.gcode.3mf`;
          this.setStage(job, 'printing', { started_at: iso(now), remote_name: remote });
          this.run = { jobId: job.id, started: now, printS: Math.max(20, Math.min(120, (job.est_seconds ?? 3600) / 60)), pausedAt: null, pausedTotal: 0 };
          this.subtask = remote;
        }
      }
    }

    // status
    const s = this.phase();
    const r = this.run;
    let progress = s === 'FINISH' ? 100 : 0;
    let remaining: number | null = null;
    if (r && (s === 'RUNNING' || s === 'PAUSE')) {
      const printed = Math.max(0, ((r.pausedAt ?? now) - r.started - r.pausedTotal) / 1000 - PREPARE_S);
      progress = Math.min(99, Math.floor((100 * printed) / r.printS));
      const job = this.jobs.find((j) => j.id === r.jobId);
      remaining = Math.round((((job?.est_seconds ?? 3600) / 60) * (100 - progress)) / 100);
    } else if (r && s === 'PREPARE') {
      remaining = Math.round((this.jobs.find((j) => j.id === r.jobId)?.est_seconds ?? 3600) / 60);
    }
    const hot = ['PREPARE', 'RUNNING', 'PAUSE'].includes(s);
    const active = this.jobs.find((j) => ['uploading', 'printing', 'awaiting_clear', 'attention'].includes(j.stage));
    Object.assign(this.hub, {
      last_seen: iso(now), state: s, progress, remaining_min: remaining,
      nozzle: hot ? 219.6 + Math.random() * 0.8 : 27, bed: hot ? 64.8 + Math.random() * 0.4 : 25,
      file: this.subtask || null, waiting_reason: waiting, active_job_id: active?.id ?? null, connected: true,
    });
    this.emitHub();
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

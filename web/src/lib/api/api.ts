import type {
  Command,
  CommandAction,
  HubStatus,
  Job,
  JobPatch,
  NewJobInput,
  Settings,
} from '../types';

export type Role = 'owner' | 'hub' | null;

export interface SessionInfo {
  userId: string;
  email: string | null;
}

export type ChangeEvent =
  | { table: 'jobs'; type: 'INSERT' | 'UPDATE'; row: Job }
  | { table: 'jobs'; type: 'DELETE'; id: string }
  | { table: 'hub_status'; row: HubStatus }
  | { table: 'settings'; row: Settings }
  | { table: 'commands'; type: 'INSERT' | 'UPDATE'; row: Command }
  | { table: '*'; type: 'RESYNC' };

/** Thrown with a message that is safe and helpful to show the user. */
export class FriendlyError extends Error {}

/**
 * Everything the UI needs from the backend. Two implementations:
 *  - SupabaseApi: the real thing (Auth, Postgres via RLS, Storage, Realtime)
 *  - DemoApi: in-memory with a simulated hub, for previews and e2e tests
 */
export interface Api {
  readonly mode: 'supabase' | 'demo';

  getSession(): Promise<SessionInfo | null>;
  onAuthChange(cb: (s: SessionInfo | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  sendMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
  myRole(): Promise<Role>;

  listJobs(): Promise<Job[]>;
  getHubStatus(): Promise<HubStatus | null>;
  getSettings(): Promise<Settings | null>;
  updateSettings(patch: Partial<Pick<Settings, 'max_late_min' | 'auto_continue' | 'ntfy_topic'>>): Promise<Settings>;

  createJob(input: NewJobInput, onProgress?: (fraction: number) => void): Promise<Job>;
  /** Re-print a finished job whose file is still stored. */
  reprintJob(job: Job, runAt: Date): Promise<Job>;
  updateJob(id: string, patch: JobPatch): Promise<Job>;
  deleteJob(id: string): Promise<void>;

  sendCommand(action: CommandAction, jobId?: string | null): Promise<Command>;

  thumbnailUrl(path: string): Promise<string | null>;

  subscribe(onChange: (e: ChangeEvent) => void): () => void;
}

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // VERIFY: Supabase free plan per-file limit

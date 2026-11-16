// Shapes of the database rows the website reads and writes.
// Keep in sync with supabase/migrations.

export const STAGES = [
  'pending',
  'uploading',
  'printing',
  'awaiting_clear',
  'attention',
  'done',
  'cancelled',
  'missed',
] as const;
export type Stage = (typeof STAGES)[number];

export const ACTIVE_STAGES: readonly Stage[] = ['uploading', 'printing', 'awaiting_clear', 'attention'];
export const FINISHED_STAGES: readonly Stage[] = ['done', 'cancelled', 'missed'];

export interface Job {
  id: string;
  owner_id: string;
  name: string;
  storage_path: string;
  thumb_path: string | null;
  file_size: number | null;
  run_at: string; // ISO UTC
  use_ams: boolean;
  ams_mapping: number[];
  stage: Stage;
  note: string | null;
  est_seconds: number | null;
  filament_g: number | null;
  filament_type: string | null;
  remote_name: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  file_purged_at: string | null;
  updated_at: string;
}

export type GcodeState = 'IDLE' | 'PREPARE' | 'RUNNING' | 'PAUSE' | 'FINISH' | 'FAILED' | 'SLICING';

export interface HubStatus {
  id: 1;
  last_seen: string | null;
  hub_version: string | null;
  last_error: string | null;
  plate_clear: boolean;
  waiting_reason: string | null;
  active_job_id: string | null;
  connected: boolean;
  state: GcodeState | string | null;
  progress: number | null;
  remaining_min: number | null;
  nozzle: number | null;
  bed: number | null;
  file: string | null;
  updated_at: string;
}

export interface Settings {
  id: 1;
  max_late_min: number;
  auto_continue: boolean;
  ntfy_topic: string | null;
  updated_at: string;
}

export type CommandAction = 'pause' | 'resume' | 'stop' | 'plate_clear';
export type CommandStatus = 'pending' | 'done' | 'failed';

export interface Command {
  id: number;
  action: CommandAction;
  status: CommandStatus;
  job_id: string | null;
  created_by: string | null;
  created_at: string;
  handled_at: string | null;
  result: string | null;
}

/** What the browser learns from a sliced .gcode.3mf before uploading it. */
export interface PrintFileInfo {
  plateGcodePath: string;
  thumbnail: Blob | null;
  estSeconds: number | null;
  filamentG: number | null;
  filamentTypes: string[];
  /** Filaments used by the plate, in slicer order (id = slicer filament number, 1-based). */
  filaments: { id: number; type: string; color: string | null; usedG: number | null }[];
  usesAms: boolean;
  printerModel: string | null;
  warnings: string[];
}

export interface NewJobInput {
  id: string;
  file: File;
  name: string;
  thumbnail: Blob | null;
  runAt: Date;
  useAms: boolean;
  amsMapping: number[];
  estSeconds: number | null;
  filamentG: number | null;
  filamentType: string | null;
}

export type JobPatch = Partial<Pick<Job, 'name' | 'run_at' | 'use_ams' | 'ams_mapping'>> & {
  stage?: 'cancelled';
};

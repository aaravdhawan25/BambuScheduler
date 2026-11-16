import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  Command,
  CommandAction,
  HubStatus,
  Job,
  JobPatch,
  NewJobInput,
  Settings,
} from '../types';
import {
  FriendlyError,
  MAX_UPLOAD_BYTES,
  type Api,
  type ChangeEvent,
  type Role,
  type SessionInfo,
} from './api';

const BUCKET = 'prints';

function safeFileName(name: string): string {
  const cleaned = name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_');
  return cleaned.slice(-120) || 'print.gcode.3mf';
}

function friendly(error: { message?: string; code?: string } | null, fallback: string): never {
  const msg = error?.message ?? '';
  if (/row-level security|permission denied|42501/i.test(msg) || error?.code === '42501') {
    throw new FriendlyError(`${fallback}: you don't have permission to do that.`);
  }
  if (/Failed to fetch|NetworkError|network/i.test(msg)) {
    throw new FriendlyError(`${fallback}: can't reach the server. Check your connection.`);
  }
  if (/only pending jobs/i.test(msg)) throw new FriendlyError('Only jobs that haven\'t started can be changed.');
  if (/cannot move a job/i.test(msg)) throw new FriendlyError('That job has already moved on, so it can\'t be changed.');
  throw new FriendlyError(msg ? `${fallback}: ${msg}` : fallback);
}

export class SupabaseApi implements Api {
  readonly mode = 'supabase' as const;
  readonly sb: SupabaseClient;
  private thumbCache = new Map<string, { url: string; expires: number }>();

  private readonly url: string;
  private readonly anonKey: string;

  constructor(url: string, anonKey: string) {
    this.url = url;
    this.anonKey = anonKey;
    this.sb = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }

  // --- auth -----------------------------------------------------------------

  async getSession(): Promise<SessionInfo | null> {
    const { data } = await this.sb.auth.getSession();
    const u = data.session?.user;
    return u ? { userId: u.id, email: u.email ?? null } : null;
  }

  onAuthChange(cb: (s: SessionInfo | null) => void): () => void {
    const { data } = this.sb.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      cb(u ? { userId: u.id, email: u.email ?? null } : null);
    });
    return () => data.subscription.unsubscribe();
  }

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (/invalid login/i.test(error.message)) throw new FriendlyError('That email and password don\'t match.');
      friendly(error, 'Sign-in failed');
    }
  }

  async sendMagicLink(email: string): Promise<void> {
    const { error } = await this.sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    if (error) friendly(error, 'Couldn\'t send the link');
  }

  async signOut(): Promise<void> {
    await this.sb.auth.signOut();
    this.thumbCache.clear();
  }

  async myRole(): Promise<Role> {
    const { data, error } = await this.sb.rpc('my_role');
    if (error) friendly(error, 'Couldn\'t check your account');
    return (data as Role) ?? null;
  }

  // --- reads ----------------------------------------------------------------

  async listJobs(): Promise<Job[]> {
    const { data, error } = await this.sb
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) friendly(error, 'Couldn\'t load prints');
    return data as Job[];
  }

  async getHubStatus(): Promise<HubStatus | null> {
    const { data, error } = await this.sb.from('hub_status').select('*').eq('id', 1).maybeSingle();
    if (error) friendly(error, 'Couldn\'t load printer status');
    return data as HubStatus | null;
  }

  async getSettings(): Promise<Settings | null> {
    const { data, error } = await this.sb.from('settings').select('*').eq('id', 1).maybeSingle();
    if (error) friendly(error, 'Couldn\'t load settings');
    return data as Settings | null;
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const { data, error } = await this.sb.from('settings').update(patch).eq('id', 1).select().single();
    if (error) {
      if (/ntfy_topic/.test(error.message)) {
        throw new FriendlyError('Topic can only use letters, numbers, - and _ (max 64).');
      }
      friendly(error, 'Couldn\'t save settings');
    }
    return data as Settings;
  }

  // --- jobs -----------------------------------------------------------------

  async createJob(input: NewJobInput, onProgress?: (f: number) => void): Promise<Job> {
    if (input.file.size > MAX_UPLOAD_BYTES) {
      throw new FriendlyError(
        `That file is ${(input.file.size / 1048576).toFixed(0)} MB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MB. ` +
          'Try fewer objects per plate or a lower-detail export.',
      );
    }
    const session = await this.getSession();
    if (!session) throw new FriendlyError('You\'ve been signed out. Sign in again.');
    const folder = `${session.userId}/${input.id}`;
    const storagePath = `${folder}/${safeFileName(input.file.name)}`;
    let thumbPath: string | null = null;

    await this.uploadWithProgress(storagePath, input.file, 'application/octet-stream', (f) =>
      onProgress?.(f * 0.97),
    );
    if (input.thumbnail) {
      thumbPath = `${folder}/thumb.png`;
      const { error } = await this.sb.storage
        .from(BUCKET)
        .upload(thumbPath, input.thumbnail, { contentType: 'image/png', upsert: true });
      if (error) thumbPath = null; // a missing thumbnail is not worth failing over
    }
    const { data, error } = await this.sb
      .from('jobs')
      .insert({
        id: input.id,
        name: input.name,
        storage_path: storagePath,
        thumb_path: thumbPath,
        file_size: input.file.size,
        run_at: input.runAt.toISOString(),
        use_ams: input.useAms,
        ams_mapping: input.amsMapping,
        est_seconds: input.estSeconds,
        filament_g: input.filamentG,
        filament_type: input.filamentType,
      })
      .select()
      .single();
    if (error) {
      await this.sb.storage.from(BUCKET).remove([storagePath, ...(thumbPath ? [thumbPath] : [])]);
      friendly(error, 'Couldn\'t create the print');
    }
    onProgress?.(1);
    return data as Job;
  }

  /** XHR upload so we can show real progress (supabase-js doesn't expose it). */
  private async uploadWithProgress(
    path: string,
    body: Blob,
    contentType: string,
    onProgress: (f: number) => void,
  ): Promise<void> {
    const { data } = await this.sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new FriendlyError('You\'ve been signed out. Sign in again.');
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.url}/storage/v1/object/${BUCKET}/${encoded}`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('apikey', this.anonKey);
      xhr.setRequestHeader('Content-Type', contentType);
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onerror = () => reject(new FriendlyError('Upload failed: can\'t reach the server. Check your connection.'));
      xhr.onload = () => {
        if (xhr.status < 300) return resolve();
        let msg = xhr.responseText;
        try {
          msg = JSON.parse(xhr.responseText).message ?? msg;
        } catch {
          /* not JSON */
        }
        if (xhr.status === 413 || /exceeded the maximum allowed size|too large/i.test(msg)) {
          reject(new FriendlyError('That file is larger than your storage plan allows (about 50 MB on the free plan).'));
        } else {
          reject(new FriendlyError(`Upload failed (${xhr.status}): ${msg}`));
        }
      };
      xhr.send(body);
    });
  }

  async reprintJob(job: Job, runAt: Date): Promise<Job> {
    if (job.file_purged_at) throw new FriendlyError('That file was cleaned up. Upload it again.');
    const id = crypto.randomUUID();
    const session = await this.getSession();
    if (!session) throw new FriendlyError('You\'ve been signed out. Sign in again.');
    const fileName = job.storage_path.split('/').pop() ?? 'print.gcode.3mf';
    const storagePath = `${session.userId}/${id}/${fileName}`;
    const copy = await this.sb.storage.from(BUCKET).copy(job.storage_path, storagePath);
    if (copy.error) throw new FriendlyError('That file is no longer stored. Upload it again.');
    let thumbPath: string | null = null;
    if (job.thumb_path) {
      const t = `${session.userId}/${id}/thumb.png`;
      if (!(await this.sb.storage.from(BUCKET).copy(job.thumb_path, t)).error) thumbPath = t;
    }
    const { data, error } = await this.sb
      .from('jobs')
      .insert({
        id,
        name: job.name,
        storage_path: storagePath,
        thumb_path: thumbPath,
        file_size: job.file_size,
        run_at: runAt.toISOString(),
        use_ams: job.use_ams,
        ams_mapping: job.ams_mapping,
        est_seconds: job.est_seconds,
        filament_g: job.filament_g,
        filament_type: job.filament_type,
      })
      .select()
      .single();
    if (error) friendly(error, 'Couldn\'t create the print');
    return data as Job;
  }

  async updateJob(id: string, patch: JobPatch): Promise<Job> {
    const { data, error } = await this.sb.from('jobs').update(patch).eq('id', id).select().single();
    if (error) friendly(error, 'Couldn\'t update the print');
    return data as Job;
  }

  async deleteJob(id: string): Promise<void> {
    const { data: job } = await this.sb.from('jobs').select('storage_path, thumb_path').eq('id', id).maybeSingle();
    const { error } = await this.sb.from('jobs').delete().eq('id', id);
    if (error) friendly(error, 'Couldn\'t delete the print');
    if (job) {
      const paths = [job.storage_path, job.thumb_path].filter(Boolean) as string[];
      await this.sb.storage.from(BUCKET).remove(paths);
    }
  }

  // --- commands -------------------------------------------------------------

  async sendCommand(action: CommandAction, jobId: string | null = null): Promise<Command> {
    const { data, error } = await this.sb
      .from('commands')
      .insert({ action, job_id: jobId })
      .select()
      .single();
    if (error) friendly(error, 'Couldn\'t send that to the printer');
    return data as Command;
  }

  // --- storage --------------------------------------------------------------

  async thumbnailUrl(path: string): Promise<string | null> {
    const cached = this.thumbCache.get(path);
    if (cached && cached.expires > Date.now()) return cached.url;
    const { data, error } = await this.sb.storage.from(BUCKET).createSignedUrl(path, 3600);
    if (error || !data) return null;
    this.thumbCache.set(path, { url: data.signedUrl, expires: Date.now() + 50 * 60_000 });
    return data.signedUrl;
  }

  // --- realtime -------------------------------------------------------------

  subscribe(onChange: (e: ChangeEvent) => void): () => void {
    let wasSubscribed = false;
    const channel = this.sb
      .channel('app-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, (p) => {
        if (p.eventType === 'DELETE') onChange({ table: 'jobs', type: 'DELETE', id: (p.old as Job).id });
        else onChange({ table: 'jobs', type: p.eventType, row: p.new as Job });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hub_status' }, (p) => {
        if (p.eventType !== 'DELETE') onChange({ table: 'hub_status', row: p.new as HubStatus });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, (p) => {
        if (p.eventType !== 'DELETE') onChange({ table: 'settings', row: p.new as Settings });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commands' }, (p) => {
        if (p.eventType !== 'DELETE') onChange({ table: 'commands', type: p.eventType, row: p.new as Command });
      })
      .subscribe((status) => {
        // After a dropped connection we may have missed events: refetch everything.
        if (status === 'SUBSCRIBED') {
          if (wasSubscribed) onChange({ table: '*', type: 'RESYNC' });
          wasSubscribed = true;
        }
      });
    return () => {
      void this.sb.removeChannel(channel);
    };
  }
}

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from './api';
import type { Command, CommandAction, HubStatus, Job, JobPatch, NewJobInput, Settings } from './types';

export const keys = {
  jobs: ['jobs'] as const,
  hub: ['hub'] as const,
  settings: ['settings'] as const,
  commands: ['commands'] as const,
};

export function useJobs() {
  return useQuery({ queryKey: keys.jobs, queryFn: () => api.listJobs() });
}

export function useHubStatus() {
  return useQuery({ queryKey: keys.hub, queryFn: () => api.getHubStatus() });
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api.getSettings() });
}

/** My commands that the hub hasn't answered yet (drives "Pausing…" etc). */
export function usePendingCommands(): Command[] {
  const { data } = useQuery<Command[]>({
    queryKey: keys.commands,
    queryFn: () => [],
    initialData: [],
    staleTime: Infinity,
  });
  return data.filter((c) => c.status === 'pending');
}

/** Re-render every `ms` (for countdowns and the hub-offline check). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const COMMAND_LABEL: Record<CommandAction, string> = {
  pause: 'Pausing',
  resume: 'Resuming',
  stop: 'Stopping',
  plate_clear: 'Marking plate clear',
};

function upsertJob(qc: QueryClient, job: Job) {
  qc.setQueryData<Job[]>(keys.jobs, (old) => {
    if (!old) return old;
    const i = old.findIndex((j) => j.id === job.id);
    if (i === -1) return [job, ...old];
    const copy = old.slice();
    copy[i] = job;
    return copy;
  });
}

/** Mount once inside the authenticated app: keeps the cache live via Realtime. */
export function useRealtimeSync() {
  const qc = useQueryClient();
  useEffect(() => {
    return api.subscribe((e) => {
      switch (e.table) {
        case 'jobs':
          if (e.type === 'DELETE') {
            qc.setQueryData<Job[]>(keys.jobs, (old) => old?.filter((j) => j.id !== e.id));
          } else {
            upsertJob(qc, e.row);
          }
          break;
        case 'hub_status':
          qc.setQueryData<HubStatus | null>(keys.hub, e.row);
          break;
        case 'settings':
          qc.setQueryData<Settings | null>(keys.settings, e.row);
          break;
        case 'commands': {
          const mine = qc.getQueryData<Command[]>(keys.commands) ?? [];
          if (!mine.some((c) => c.id === e.row.id)) break;
          qc.setQueryData<Command[]>(keys.commands, mine.map((c) => (c.id === e.row.id ? e.row : c)));
          if (e.row.status === 'done') toast.success(e.row.result ?? 'Done', { id: `cmd-${e.row.id}` });
          if (e.row.status === 'failed') toast.error(e.row.result ?? 'The printer refused that.', { id: `cmd-${e.row.id}` });
          break;
        }
        case '*':
          void qc.invalidateQueries();
          break;
      }
    });
  }, [qc]);
}

export function useSendCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, jobId }: { action: CommandAction; jobId?: string | null }) =>
      api.sendCommand(action, jobId),
    onSuccess: (cmd) => {
      qc.setQueryData<Command[]>(keys.commands, (old) => [...(old ?? []), cmd]);
      toast.loading(`${COMMAND_LABEL[cmd.action]}…`, { id: `cmd-${cmd.id}` });
      // If the hub never answers, don't leave a spinner up forever.
      setTimeout(() => {
        const c = qc.getQueryData<Command[]>(keys.commands)?.find((x) => x.id === cmd.id);
        if (c?.status === 'pending') {
          toast.warning('The hub hasn’t picked this up yet. It will run if the hub reconnects within 5 minutes.', {
            id: `cmd-${cmd.id}`,
          });
          qc.setQueryData<Command[]>(keys.commands, (old) => old?.filter((x) => x.id !== cmd.id));
        }
      }, 30_000);
    },
    onError: (e) => toast.error((e as Error).message),
  });
}

export function useUpdateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: JobPatch }) => api.updateJob(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: keys.jobs });
      const prev = qc.getQueryData<Job[]>(keys.jobs);
      qc.setQueryData<Job[]>(keys.jobs, (old) => old?.map((j) => (j.id === id ? { ...j, ...patch } : j)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.jobs, ctx.prev);
      toast.error((e as Error).message);
    },
    onSuccess: (job) => upsertJob(qc, job),
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteJob(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.jobs });
      const prev = qc.getQueryData<Job[]>(keys.jobs);
      qc.setQueryData<Job[]>(keys.jobs, (old) => old?.filter((j) => j.id !== id));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.jobs, ctx.prev);
      toast.error((e as Error).message);
    },
    onSuccess: () => toast.success('Removed from history'),
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ input, onProgress }: { input: NewJobInput; onProgress?: (f: number) => void }) =>
      api.createJob(input, onProgress),
    onSuccess: (job) => upsertJob(qc, job),
  });
}

export function useReprintJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ job, runAt }: { job: Job; runAt: Date }) => api.reprintJob(job, runAt),
    onSuccess: (job) => upsertJob(qc, job),
    onError: (e) => toast.error((e as Error).message),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<Settings, 'max_late_min' | 'auto_continue' | 'ntfy_topic'>>) =>
      api.updateSettings(patch),
    onMutate: async (patch) => {
      const prev = qc.getQueryData<Settings | null>(keys.settings);
      if (prev) qc.setQueryData(keys.settings, { ...prev, ...patch });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(keys.settings, ctx.prev);
      toast.error((e as Error).message);
    },
    onSuccess: (s) => {
      qc.setQueryData(keys.settings, s);
      toast.success('Settings saved');
    },
  });
}

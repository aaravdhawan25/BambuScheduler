import type { ReactNode } from 'react';
import { displayName, formatDuration } from '@/lib/format';
import { STAGE_BADGE } from '@/lib/status';
import type { Job } from '@/lib/types';
import { RelativeTime } from './RelativeTime';
import { StatusBadge } from './StatusBadge';
import { Thumb } from './Thumb';

export function JobRow({ job, time, meta, actions }: { job: Job; time: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <li className="rounded-2xl border bg-card p-3 shadow-card">
      <div className="flex gap-3">
        <Thumb path={job.thumb_path} alt="" className="size-16" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="truncate font-medium" title={job.name}>{displayName(job.name)}</p>
            <StatusBadge badge={STAGE_BADGE[job.stage]} className="shrink-0" />
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {time}
            {meta && <> · {meta}</>}
          </p>
          {job.note && <p className="mt-1 text-sm">{job.note}</p>}
        </div>
      </div>
      {actions && <div className="mt-3 flex flex-wrap justify-end gap-2">{actions}</div>}
    </li>
  );
}

export function RunTime({ job }: { job: Job }) {
  return (
    <>
      <RelativeTime date={job.run_at} mode="clock" /> · {formatDuration(job.est_seconds)}
    </>
  );
}

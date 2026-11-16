import { History as HistoryIcon, RotateCcw, Trash2, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { EmptyState } from '@/components/EmptyState';
import { JobRow } from '@/components/JobRow';
import { ListSkeleton } from '@/components/PageSkeleton';
import { RelativeTime } from '@/components/RelativeTime';
import { SchedulePicker } from '@/components/SchedulePicker';
import { resolveChoice, type ScheduleChoice } from '@/lib/schedule';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { clockTime, displayName, formatDuration } from '@/lib/format';
import { useDeleteJob, useJobs, useNow, useReprintJob } from '@/lib/queries';
import type { Job, Stage } from '@/lib/types';
import { cn } from '@/lib/utils';

const FILTERS: { id: 'all' | Stage; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'done', label: 'Done' },
  { id: 'missed', label: 'Missed' },
  { id: 'cancelled', label: 'Cancelled' },
];

function actualDuration(job: Job): number | null {
  if (!job.started_at || !job.finished_at) return null;
  return (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000;
}

export default function History() {
  const { data: jobs, isLoading, error, refetch } = useJobs();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');
  const [reprinting, setReprinting] = useState<Job | null>(null);
  const del = useDeleteJob();
  const navigate = useNavigate();
  const now = useNow(30_000);

  const past = useMemo(
    () =>
      (jobs ?? [])
        .filter((j) => ['done', 'cancelled', 'missed'].includes(j.stage))
        .filter((j) => filter === 'all' || j.stage === filter)
        .sort((a, b) => (b.finished_at ?? b.updated_at).localeCompare(a.finished_at ?? a.updated_at)),
    [jobs, filter],
  );

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">History</h1>

      <div role="radiogroup" aria-label="Filter" className="flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            role="radio"
            aria-checked={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'h-9 shrink-0 rounded-full border px-4 text-sm font-medium transition-colors',
              filter === f.id ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : error ? (
        <div className="space-y-3 rounded-2xl border p-5">
          <p className="font-medium">Couldn't load history.</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
          <Button variant="secondary" onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : past.length === 0 ? (
        <EmptyState icon={HistoryIcon} title={filter === 'all' ? 'No prints yet' : `No ${filter} prints`}>
          {filter === 'all' && (
            <>
              <p>Drop a file to start.</p>
              <Button asChild className="mt-4">
                <Link to="/new">New print</Link>
              </Button>
            </>
          )}
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {past.map((job) => {
            const took = actualDuration(job);
            return (
              <JobRow
                key={job.id}
                job={job}
                time={job.finished_at ? <RelativeTime date={job.finished_at} /> : '—'}
                meta={took != null ? `took ${formatDuration(took)}` : job.filament_g ? `${Math.round(job.filament_g)} g` : undefined}
                actions={
                  <>
                    <Confirm
                      title="Remove from history?"
                      description={`“${displayName(job.name)}” and its stored file will be deleted. This can't be undone.`}
                      confirmLabel="Delete"
                      onConfirm={() => del.mutateAsync(job.id).then(() => undefined)}
                    >
                      <Button variant="ghost" size="sm" aria-label={`Delete ${displayName(job.name)} from history`}>
                        <Trash2 aria-hidden />
                      </Button>
                    </Confirm>
                    {job.file_purged_at ? (
                      <Button variant="secondary" size="sm" onClick={() => navigate('/new')} title="The stored file was cleaned up after 7 days">
                        <Upload aria-hidden /> Re-upload to print
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" onClick={() => setReprinting(job)}>
                        <RotateCcw aria-hidden /> Print again
                      </Button>
                    )}
                  </>
                }
              />
            );
          })}
        </ul>
      )}

      {reprinting && (
        <ReprintDialog job={reprinting} jobs={jobs ?? []} now={now} onClose={() => setReprinting(null)} />
      )}
    </div>
  );
}

function ReprintDialog({ job, jobs, now, onClose }: { job: Job; jobs: Job[]; now: number; onClose: () => void }) {
  const reprint = useReprintJob();
  const navigate = useNavigate();
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'now' });
  const at = resolveChoice(choice);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Print again" description={displayName(job.name)}>
      <SchedulePicker value={choice} onChange={setChoice} estSeconds={job.est_seconds} jobs={jobs} now={now} />
      <p className="mt-4 text-sm text-muted-foreground">
        The plate must be empty and filament loaded{job.use_ams ? ' in the same AMS slots as last time' : ''}.
      </p>
      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={reprint.isPending || (choice.kind === 'at' && at.getTime() < now - 60_000)}
        onClick={() =>
          reprint.mutate(
            { job, runAt: at },
            {
              onSuccess: () => {
                toast.success(choice.kind === 'now' ? 'Queued to print as soon as the printer is ready' : `Scheduled for ${clockTime(at)}`);
                onClose();
                navigate(choice.kind === 'now' ? '/' : '/queue');
              },
            },
          )
        }
      >
        <RotateCcw aria-hidden />
        {choice.kind === 'now' ? 'Print as soon as ready' : `Schedule for ${clockTime(at, now)}`}
      </Button>
    </Dialog>
  );
}

import { format } from 'date-fns';
import { CalendarClock, GanttChart, List, Play, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { JobRow, RunTime } from '@/components/JobRow';
import { ListSkeleton } from '@/components/PageSkeleton';
import { EmptyState } from '@/components/EmptyState';
import { SchedulePicker } from '@/components/SchedulePicker';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { clockTime, displayName } from '@/lib/format';
import { useHubStatus, useJobs, useNow, useUpdateJob } from '@/lib/queries';
import { jobWindow, resolveChoice, type ScheduleChoice } from '@/lib/schedule';
import { STAGE_BADGE } from '@/lib/status';
import type { Job } from '@/lib/types';
import { cn } from '@/lib/utils';

const QUEUE_STAGES = ['pending', 'uploading', 'printing', 'awaiting_clear', 'attention'];

export default function Queue() {
  const { data: jobs, isLoading, error, refetch } = useJobs();
  const { data: hub } = useHubStatus();
  const now = useNow(15_000);
  const [view, setView] = useState<'list' | 'timeline'>('list');
  const [rescheduling, setRescheduling] = useState<Job | null>(null);
  const update = useUpdateJob();

  const queue = useMemo(
    () =>
      (jobs ?? [])
        .filter((j) => QUEUE_STAGES.includes(j.stage))
        .sort((a, b) => {
          const pa = a.stage === 'pending' ? 1 : 0;
          const pb = b.stage === 'pending' ? 1 : 0;
          return pa - pb || a.run_at.localeCompare(b.run_at);
        }),
    [jobs],
  );

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Queue</h1>
        <div role="tablist" aria-label="View" className="flex rounded-xl bg-muted p-1">
          {(['list', 'timeline'] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium capitalize transition-colors',
                view === v ? 'bg-card shadow-sm' : 'text-muted-foreground',
              )}
            >
              {v === 'list' ? <List aria-hidden className="size-4" /> : <GanttChart aria-hidden className="size-4" />}
              {v}
            </button>
          ))}
        </div>
      </header>

      {isLoading ? (
        <ListSkeleton />
      ) : error ? (
        <div className="space-y-3 rounded-2xl border p-5">
          <p className="font-medium">Couldn't load the queue.</p>
          <p className="text-sm text-muted-foreground">{error.message}</p>
          <Button variant="secondary" onClick={() => void refetch()}>Try again</Button>
        </div>
      ) : queue.length === 0 ? (
        <EmptyState icon={CalendarClock} title="Nothing in the queue">
          <p>Schedule a print and it shows up here.</p>
          <Button asChild className="mt-4">
            <Link to="/new"><Plus aria-hidden /> New print</Link>
          </Button>
        </EmptyState>
      ) : view === 'list' ? (
        <ul className="space-y-3">
          {queue.map((job) => {
            const due = job.stage === 'pending' && Date.parse(job.run_at) <= now;
            return (
              <JobRow
                key={job.id}
                job={job}
                time={<RunTime job={job} />}
                meta={due && hub?.waiting_reason ? <span className="text-warning">{hub.waiting_reason}</span> : undefined}
                actions={
                  job.stage === 'pending' ? (
                    <>
                      <Confirm
                        title={`Cancel “${displayName(job.name)}”?`}
                        description="It won't print. You can re-print it from History while the file is still stored."
                        confirmLabel="Cancel print"
                        onConfirm={() => update.mutateAsync({ id: job.id, patch: { stage: 'cancelled' } }).then(() => undefined)}
                      >
                        <Button variant="ghost" size="sm"><X aria-hidden /> Cancel</Button>
                      </Confirm>
                      <Button variant="secondary" size="sm" onClick={() => setRescheduling(job)}>
                        <CalendarClock aria-hidden /> Reschedule
                      </Button>
                      {!due && (
                        <Confirm
                          title="Print now?"
                          description="It starts as soon as the printer is idle and the plate is confirmed clear."
                          confirmLabel="Print now"
                          tone="default"
                          onConfirm={() => update.mutateAsync({ id: job.id, patch: { run_at: new Date().toISOString() } }).then(() => undefined)}
                        >
                          <Button size="sm"><Play aria-hidden /> Print now</Button>
                        </Confirm>
                      )}
                    </>
                  ) : job.stage === 'attention' ? (
                    <Confirm
                      title="Dismiss this job?"
                      description="Marks it cancelled. You still need to confirm the plate is clear on the Home screen before anything else prints."
                      confirmLabel="Dismiss"
                      onConfirm={() => update.mutateAsync({ id: job.id, patch: { stage: 'cancelled' } }).then(() => undefined)}
                    >
                      <Button variant="ghost" size="sm"><X aria-hidden /> Dismiss</Button>
                    </Confirm>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      ) : (
        <Timeline jobs={queue} now={now} />
      )}

      {rescheduling && (
        <RescheduleDialog job={rescheduling} jobs={jobs ?? []} now={now} onClose={() => setRescheduling(null)} />
      )}
    </div>
  );
}

function RescheduleDialog({ job, jobs, now, onClose }: { job: Job; jobs: Job[]; now: number; onClose: () => void }) {
  const update = useUpdateJob();
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'at', at: new Date(job.run_at) });
  const at = resolveChoice(choice);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Reschedule" description={displayName(job.name)}>
      <SchedulePicker value={choice} onChange={setChoice} estSeconds={job.est_seconds} jobs={jobs} excludeId={job.id} now={now} />
      <Button
        size="lg"
        className="mt-5 w-full"
        disabled={update.isPending || (choice.kind === 'at' && at.getTime() < now - 60_000)}
        onClick={() =>
          update.mutate(
            { id: job.id, patch: { run_at: at.toISOString() } },
            { onSuccess: onClose },
          )
        }
      >
        {choice.kind === 'now' ? 'Print as soon as ready' : `Move to ${clockTime(at, now)}`}
      </Button>
    </Dialog>
  );
}

const HOUR = 3600_000;

function Timeline({ jobs, now }: { jobs: Job[]; now: number }) {
  const windows = jobs.map((j) => ({ job: j, ...jobWindow(j, now) }));
  const start = Math.min(now, ...windows.map((w) => w.start)) - HOUR / 2;
  const end = Math.max(start + 12 * HOUR, ...windows.map((w) => w.end)) + HOUR / 2;
  const span = end - start;
  // Fit the whole range on screen when it's reasonable; otherwise scroll sideways.
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(600);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setBoxWidth(e.contentRect.width));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const pxPerHour = Math.min(80, Math.max(18, boxWidth / (span / HOUR)));
  const width = Math.max(boxWidth, (span / HOUR) * pxPerHour);
  const labelEvery = pxPerHour >= 48 ? 1 : pxPerHour >= 24 ? 3 : 6;
  const x = (t: number) => ((t - start) / span) * width;
  const firstTick = Math.ceil(start / HOUR) * HOUR;
  const ticks = Array.from({ length: Math.floor((end - firstTick) / HOUR) + 1 }, (_, i) => firstTick + i * HOUR);
  const toneBg: Record<string, string> = {
    accent: 'bg-primary/25 border-primary/60', info: 'bg-info/20 border-info/50', warning: 'bg-warning/20 border-warning/60',
    danger: 'bg-danger/20 border-danger/60', success: 'bg-success/20 border-success/50', neutral: 'bg-muted border-border',
  };

  return (
    <figure className="rounded-2xl border bg-card shadow-card">
      <figcaption className="sr-only">Timeline of upcoming prints</figcaption>
      <div ref={box} className="overflow-x-auto overscroll-x-contain">
        <div className="relative" style={{ width, height: 56 + windows.length * 52 }}>
          {ticks.map((t) => {
            const d = new Date(t);
            const midnight = d.getHours() === 0;
            return (
              <div key={t} className="absolute top-0 h-full" style={{ left: x(t) }}>
                <div className={cn('h-full border-l', midnight ? 'border-foreground/30' : 'border-border/60')} />
                <span className="tabular absolute left-1 top-2 whitespace-nowrap text-[11px] text-muted-foreground">
                  {midnight ? format(d, 'EEE d') : d.getHours() % labelEvery === 0 ? format(d, 'HH:mm') : ''}
                </span>
              </div>
            );
          })}
          <div className="absolute top-0 z-10 h-full" style={{ left: x(now) }} aria-hidden>
            <div className="h-full border-l-2 border-primary" />
            <span className="absolute left-1 bottom-1 rounded bg-primary px-1 text-[10px] font-medium text-primary-foreground">now</span>
          </div>
          <ol>
            {windows.map((w, i) => {
              const badge = STAGE_BADGE[w.job.stage];
              return (
                <li
                  key={w.job.id}
                  className={cn('absolute flex h-11 items-center overflow-hidden rounded-xl border px-3 text-sm', toneBg[badge.tone])}
                  style={{ left: x(w.start), width: Math.max(44, x(w.end) - x(w.start)), top: 36 + i * 52 }}
                  title={`${displayName(w.job.name)}: ${format(w.start, 'p')} – ${format(w.end, 'p')} (${badge.label})`}
                >
                  <span className="truncate text-xs font-medium sm:text-sm">{displayName(w.job.name)}</span>
                  <span className="sr-only">
                    {badge.label}, {format(w.start, 'EEE p')} to {format(w.end, 'p')}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <p className="border-t px-4 py-2 text-xs text-muted-foreground">Bars use each print's estimated time. Scroll sideways to see more.</p>
    </figure>
  );
}

import { format } from 'date-fns';
import { m, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CalendarClock, CheckCircle2, Loader2, Pause, Play, Plus, Square, Thermometer } from 'lucide-react';
import { Link } from 'react-router';
import { HoldButton } from '@/components/HoldButton';
import { PageSkeleton } from '@/components/PageSkeleton';
import { ProgressRing } from '@/components/ProgressRing';
import { RelativeTime } from '@/components/RelativeTime';
import { StatusBadge } from '@/components/StatusBadge';
import { Thumb } from '@/components/Thumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Confirm } from '@/components/ui/confirm';
import { countdown, displayName, formatDuration } from '@/lib/format';
import { useHubStatus, useJobs, useNow, usePendingCommands, useSendCommand } from '@/lib/queries';
import { activeJob, isHubOnline, isPrinterBusy, nextPendingJob, printerBadge, STAGE_BADGE } from '@/lib/status';
import type { HubStatus, Job } from '@/lib/types';

export default function Dashboard() {
  const jobs = useJobs();
  const hub = useHubStatus();
  const now = useNow(1000);

  if (jobs.isLoading || hub.isLoading) return <PageSkeleton />;
  if (jobs.error || hub.error) {
    return (
      <Card>
        <CardContent className="space-y-3">
          <p className="font-medium">Couldn't load your printer.</p>
          <p className="text-sm text-muted-foreground">{(jobs.error ?? hub.error)?.message}</p>
          <Button variant="secondary" onClick={() => { void jobs.refetch(); void hub.refetch(); }}>Try again</Button>
        </CardContent>
      </Card>
    );
  }

  const allJobs = jobs.data ?? [];
  const status = hub.data ?? null;
  const online = isHubOnline(status, now);
  const current = activeJob(allJobs, status);
  const next = nextPendingJob(allJobs);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Printer</h1>
        <StatusBadge badge={printerBadge(status, online)} size="lg" />
      </header>

      {status && !status.plate_clear && !(online && isPrinterBusy(status)) && current?.stage !== 'printing' && current?.stage !== 'uploading' && (
        <PlateBanner hub={status} job={current} online={online} />
      )}
      <HeroCard hub={status} job={current} online={online} now={now} />
      <NextUpCard job={next} hub={status} now={now} />
    </div>
  );
}

function PlateBanner({ hub, job, online }: { hub: HubStatus; job: Job | null; online: boolean }) {
  const send = useSendCommand();
  const pending = usePendingCommands().some((c) => c.action === 'plate_clear');
  const attention = job?.stage === 'attention' ? job : null;
  const reduce = useReducedMotion();

  return (
    <m.section
      aria-labelledby="plate-title"
      initial={reduce ? false : { opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`rounded-2xl border p-5 ${attention ? 'border-danger/40 bg-danger/10' : 'border-warning/40 bg-warning/10'}`}
    >
      <div className="flex items-start gap-3">
        {attention ? (
          <AlertTriangle aria-hidden className="mt-0.5 size-6 shrink-0 text-danger" />
        ) : (
          <CheckCircle2 aria-hidden className="mt-0.5 size-6 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <h2 id="plate-title" className="text-lg font-semibold tracking-tight">
            {attention ? 'A print needs your attention' : 'Plate needs clearing'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {attention?.note ??
              (job?.stage === 'awaiting_clear'
                ? `${displayName(job.name)} is finished. Remove the print, check the plate is empty and filament is loaded.`
                : 'Nothing will print until you confirm the build plate is empty.')}
          </p>
          {hub.waiting_reason && (
            <p className="mt-2 text-sm font-medium">{hub.waiting_reason}.</p>
          )}
        </div>
      </div>
      <Confirm
          title="Is the plate clear?"
          description={
            <>
              Confirm the build plate is <strong>empty</strong>, in place, and filament is loaded.
              {hub.waiting_reason ? ' A print that is due will start right away.' : ''}
            </>
          }
          confirmLabel="Yes, plate is clear"
          cancelLabel="Not yet"
          tone="default"
          onConfirm={() => send.mutateAsync({ action: 'plate_clear', jobId: job?.id ?? null }).then(() => undefined)}
        >
          <Button size="xl" className="mt-4 w-full" disabled={!online || pending}>
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : <CheckCircle2 aria-hidden />}
            {pending ? 'Confirming…' : 'Plate is clear'}
          </Button>
        </Confirm>
    </m.section>
  );
}

function HeroCard({ hub, job, online, now }: { hub: HubStatus | null; job: Job | null; online: boolean; now: number }) {
  const send = useSendCommand();
  const pending = usePendingCommands();
  const state = hub?.state;
  const connected = online && !!hub?.connected;
  const active = connected && isPrinterBusy(hub);
  const printing = state === 'RUNNING' || state === 'PAUSE';
  const progress = !connected ? null : printing ? (hub?.progress ?? 0) : state === 'FINISH' ? 100 : state === 'PREPARE' ? 0 : null;
  const remaining = hub?.remaining_min;
  const eta = active && remaining != null ? new Date(now + remaining * 60_000) : null;
  const name = job ? displayName(job.name) : hub?.file ? displayName(hub.file) : null;
  const cmdPending = (a: string) => pending.some((c) => c.action === a);
  const anyPending = pending.some((c) => c.action !== 'plate_clear');

  const centre = (() => {
    if (!online) return { big: '—', small: 'Hub offline' };
    if (!hub?.connected) return { big: '—', small: 'Printer offline' };
    if (printing) return { big: `${hub.progress ?? 0}%`, small: state === 'PAUSE' ? 'Paused' : 'Printing' };
    if (state === 'PREPARE') return { big: '…', small: 'Preparing' };
    if (state === 'FINISH') return { big: '100%', small: 'Finished' };
    if (state === 'FAILED') return { big: '!', small: 'Stopped' };
    return { big: 'Ready', small: 'Idle' };
  })();

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-6 sm:flex-row sm:items-center">
        <ProgressRing
          value={progress}
          label="Print progress"
          tone={state === 'PAUSE' ? 'var(--warning)' : state === 'FAILED' ? 'var(--danger)' : 'var(--primary)'}
        >
          <div>
            <div className="tabular text-4xl font-semibold tracking-tight">{centre.big}</div>
            <div className="mt-1 text-sm text-muted-foreground">{centre.small}</div>
          </div>
        </ProgressRing>

        <div className="w-full min-w-0 flex-1 space-y-4">
          <div className="flex items-center gap-3">
            <Thumb path={job?.thumb_path ?? null} alt="" className="size-14" />
            <div className="min-w-0">
              <p className="truncate font-medium" title={name ?? undefined}>
                {name ?? 'No print loaded'}
              </p>
              {job ? (
                <StatusBadge badge={STAGE_BADGE[job.stage]} className="mt-1" />
              ) : (
                <p className="text-sm text-muted-foreground">Start one from New print.</p>
              )}
            </div>
          </div>

          {active && (
            <dl className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">Time left</dt>
                <dd className="tabular font-medium">{remaining != null ? formatDuration(remaining * 60) : '—'}</dd>
              </div>
              <div className="rounded-xl bg-muted px-3 py-2">
                <dt className="text-xs text-muted-foreground">Done at</dt>
                <dd className="tabular font-medium">{eta ? format(eta, 'p') : '—'}</dd>
              </div>
            </dl>
          )}

          {connected && (
            <div className="flex gap-4 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <Thermometer aria-hidden className="size-4" />
                <span>Nozzle</span>
                <span className="tabular text-foreground">{hub?.nozzle != null ? `${Math.round(hub.nozzle)}°C` : '—'}</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span>Bed</span>
                <span className="tabular text-foreground">{hub?.bed != null ? `${Math.round(hub.bed)}°C` : '—'}</span>
              </span>
            </div>
          )}

          {active && (
            <div className="grid grid-cols-2 gap-3">
              {state === 'PAUSE' ? (
                <Button size="xl" onClick={() => send.mutate({ action: 'resume' })} disabled={anyPending}>
                  {cmdPending('resume') ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
                  Resume
                </Button>
              ) : (
                <Button size="xl" variant="secondary" onClick={() => send.mutate({ action: 'pause' })} disabled={anyPending}>
                  {cmdPending('pause') ? <Loader2 aria-hidden className="animate-spin" /> : <Pause aria-hidden />}
                  Pause
                </Button>
              )}
              <HoldButton onConfirm={() => send.mutate({ action: 'stop' })} disabled={anyPending}>
                {cmdPending('stop') ? <Loader2 aria-hidden className="size-5 animate-spin" /> : <Square aria-hidden className="size-4" />}
                Stop
              </HoldButton>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NextUpCard({ job, hub, now }: { job: Job | null; hub: HubStatus | null; now: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Next up</CardTitle>
        <Link to="/queue" className="text-sm text-primary hover:underline">
          Queue
        </Link>
      </CardHeader>
      <CardContent>
        {job ? (
          <div className="flex items-center gap-4">
            <Thumb path={job.thumb_path} alt="" className="size-16" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{displayName(job.name)}</p>
              <p className="text-sm text-muted-foreground">
                <RelativeTime date={job.run_at} mode="clock" /> · {formatDuration(job.est_seconds)}
              </p>
              {Date.parse(job.run_at) <= now ? (
                <p className="mt-1 text-sm font-medium text-warning" role="status">
                  {hub?.waiting_reason ? `${hub.waiting_reason}.` : 'Starting…'}
                </p>
              ) : (
                <p className="tabular mt-1 text-sm font-medium" aria-label={`Starts in ${countdown(Date.parse(job.run_at) - now)}`}>
                  <CalendarClock aria-hidden className="mr-1 inline size-4 align-[-3px] text-primary" />
                  {countdown(Date.parse(job.run_at) - now)}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
            <Button asChild variant="secondary">
              <Link to="/new">
                <Plus aria-hidden /> New print
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

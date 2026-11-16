import { format } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { displayName } from '@/lib/format';
import {
  estimatedFinish,
  fromLocalInput,
  overlappingJobs,
  quickChips,
  resolveChoice,
  toLocalInput,
  type ScheduleChoice,
} from '@/lib/schedule';
import type { Job } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Input } from './ui/input';

/** Quick chips + custom date/time, with finish estimate and overlap warning. */
export function SchedulePicker({
  value,
  onChange,
  estSeconds,
  jobs,
  excludeId,
  now,
}: {
  value: ScheduleChoice;
  onChange: (c: ScheduleChoice) => void;
  estSeconds: number | null;
  jobs: Job[];
  excludeId?: string;
  now: number;
}) {
  // Chips are recomputed once a minute (via `now`) so "In 1 hour" stays honest.
  const minute = Math.floor(now / 60_000);
  const chips = useMemo(() => quickChips(new Date(minute * 60_000)), [minute]);
  const start = resolveChoice(value);
  const finish = estimatedFinish(start, estSeconds, now);
  const clashes = overlappingJobs(jobs, start, estSeconds, excludeId, now);
  const inPast = value.kind === 'at' && start.getTime() < now - 60_000;
  const selectedChip = value.kind === 'now' ? 'now' : value.chip;

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="When to print" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {chips.map((c) => {
          const selected = selectedChip === c.id;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(c.id === 'now' ? { kind: 'now' } : { kind: 'at', at: c.at, chip: c.id })}
              className={cn(
                'h-12 rounded-xl border px-3 text-sm font-medium transition-colors',
                selected ? 'border-primary bg-primary/15 text-primary' : 'hover:bg-muted',
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        <label htmlFor="custom-time" className="text-sm text-muted-foreground">
          Or pick a date and time
        </label>
        <Input
          id="custom-time"
          type="datetime-local"
          min={toLocalInput(new Date(now))}
          value={value.kind === 'at' && !value.chip ? toLocalInput(value.at) : ''}
          onChange={(e) => {
            const d = fromLocalInput(e.target.value);
            if (d) onChange({ kind: 'at', at: d });
          }}
          aria-invalid={inPast}
        />
      </div>

      <div className="rounded-xl bg-muted px-4 py-3 text-sm" aria-live="polite">
        <p>
          <span className="text-muted-foreground">Starts </span>
          <span className="font-medium">{value.kind === 'now' ? 'as soon as the printer is ready' : format(start, 'EEE d MMM, p')}</span>
        </p>
        <p>
          <span className="text-muted-foreground">Finishes around </span>
          <span className="font-medium">{format(finish, 'EEE p')}</span>
          {estSeconds == null && <span className="text-muted-foreground"> (assuming 1 h)</span>}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">Times are in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).</p>
      </div>

      {inPast && (
        <p role="alert" className="text-sm text-danger">That time has already passed. Pick a later time or choose Now.</p>
      )}
      {clashes.length > 0 && (
        <div role="alert" className="flex gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            Overlaps with {clashes.map((j) => `“${displayName(j.name)}”`).join(', ')}. It will wait until the plate is cleared
            after that print, and may be marked missed if it waits too long.
          </p>
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';
import { clockTime, exactTime, relative } from '@/lib/format';
import { useNow } from '@/lib/queries';

/** "in 2 h" — tap (or hover) to see the exact local time. */
export function RelativeTime({ date, mode = 'relative' }: { date: string | Date; mode?: 'relative' | 'clock' }) {
  const now = useNow(15_000);
  const [showExact, setShowExact] = useState(false);
  const d = typeof date === 'string' ? new Date(date) : date;
  const text = showExact ? clockTime(d, now) : mode === 'relative' ? relative(d, now) : clockTime(d, now);
  const alt = mode === 'relative' ? clockTime(d, now) : relative(d, now);
  return (
    <button
      type="button"
      title={exactTime(d)}
      onClick={(e) => {
        e.stopPropagation();
        setShowExact((v) => !v);
      }}
      className="tabular rounded underline decoration-dotted decoration-muted-foreground/40 underline-offset-4 hover:decoration-muted-foreground"
      aria-label={`${text} (${exactTime(d)})`}
    >
      <time dateTime={d.toISOString()}>{showExact ? alt : text}</time>
    </button>
  );
}

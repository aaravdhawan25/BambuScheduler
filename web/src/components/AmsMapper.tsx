import type { PrintFileInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

const SLOTS = [0, 1, 2, 3];

/**
 * Pick which AMS slot feeds each filament the file uses.
 * `mapping[filamentId - 1]` = 0-based slot, -1 = unused. VERIFY on the A1.
 */
export function AmsMapper({
  filaments,
  mapping,
  onChange,
}: {
  filaments: PrintFileInfo['filaments'];
  mapping: number[];
  onChange: (m: number[]) => void;
}) {
  return (
    <ul className="space-y-3">
      {filaments.map((f) => {
        const current = mapping[f.id - 1] ?? -1;
        return (
          <li key={f.id} className="flex flex-wrap items-center gap-3">
            <span className="flex min-w-32 items-center gap-2 text-sm">
              <span
                aria-hidden
                className="size-5 rounded-full border"
                style={{ background: f.color ?? 'transparent' }}
              />
              <span>
                <span className="font-medium">{f.type}</span>
                {f.usedG != null && <span className="text-muted-foreground"> · {f.usedG.toFixed(0)} g</span>}
              </span>
            </span>
            <div role="radiogroup" aria-label={`AMS slot for filament ${f.id} (${f.type})`} className="flex gap-1.5">
              {SLOTS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={current === s}
                  onClick={() => {
                    const next = mapping.slice();
                    while (next.length < f.id) next.push(-1);
                    next[f.id - 1] = s;
                    onChange(next);
                  }}
                  className={cn(
                    'size-11 rounded-xl border text-sm font-medium transition-colors',
                    current === s ? 'border-primary bg-primary/15 text-primary' : 'hover:bg-muted',
                  )}
                >
                  {s + 1}
                </button>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

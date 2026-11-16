import { m, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/** Circular progress. `value` 0–100; null = indeterminate (empty track). */
export function ProgressRing({
  value,
  size = 200,
  stroke = 14,
  tone = 'var(--primary)',
  children,
  label,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  tone?: string;
  children?: ReactNode;
  label: string;
}) {
  const reduce = useReducedMotion();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div
      className="relative grid place-items-center"
      style={{ width: size, height: size }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        <m.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - pct / 100) }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 60, damping: 20 }}
          style={{ opacity: value == null ? 0 : 1 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

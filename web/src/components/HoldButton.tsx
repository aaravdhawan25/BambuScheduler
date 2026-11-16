import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Press-and-hold to confirm (pointer or keyboard: hold Space/Enter).
 * Fills up over `ms`; releasing early cancels. For Stop and similar.
 */
export function HoldButton({
  onConfirm,
  children,
  ms = 1500,
  disabled,
  className,
  hint = 'Hold to confirm',
  label = 'Stop',
}: {
  onConfirm: () => void;
  children: ReactNode;
  ms?: number;
  disabled?: boolean;
  className?: string;
  hint?: string;
  label?: string;
}) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const fired = useRef(false);

  const stop = () => {
    start.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    if (!fired.current) setProgress(0);
  };

  const frame = (t: number) => {
    if (start.current == null) start.current = t;
    const p = Math.min(1, (t - start.current) / ms);
    setProgress(p);
    if (p >= 1) {
      fired.current = true;
      stop();
      onConfirm();
      setTimeout(() => {
        fired.current = false;
        setProgress(0);
      }, 600);
      return;
    }
    raf.current = requestAnimationFrame(frame);
  };

  const begin = () => {
    if (disabled || raf.current) return;
    fired.current = false;
    raf.current = requestAnimationFrame(frame);
  };

  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${label} (${hint.toLowerCase()})`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        'relative isolate inline-flex h-14 touch-none select-none items-center justify-center gap-2 overflow-hidden rounded-xl border border-danger/40 px-5 font-medium text-danger transition-opacity disabled:opacity-45',
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 -z-10 bg-danger/20"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="flex flex-col items-center leading-tight">
        <span className="inline-flex items-center gap-2">{children}</span>
        <span className="text-[11px] font-normal opacity-75">
          {progress > 0 && progress < 1 ? 'Keep holding…' : hint}
        </span>
      </span>
      <span className="sr-only" aria-live="polite">
        {progress > 0 && progress < 1 ? 'Keep holding' : ''}
      </span>
    </button>
  );
}

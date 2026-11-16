import {
  AlertTriangle, Ban, CheckCircle2, Circle, Clock, Flame, Hourglass, Layers, Pause, Upload, WifiOff, Wrench,
} from 'lucide-react';
import type { Badge, Tone } from '@/lib/status';
import { cn } from '@/lib/utils';

const TONE: Record<Tone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  accent: 'bg-primary/15 text-primary',
  info: 'bg-info/15 text-info',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
};

const ICON = {
  idle: Circle, prepare: Flame, print: Layers, pause: Pause, done: CheckCircle2, error: AlertTriangle,
  offline: WifiOff, clock: Clock, upload: Upload, plate: Wrench, cancel: Ban, missed: Hourglass,
} as const;

export function StatusBadge({ badge, className, size = 'sm' }: { badge: Badge; className?: string; size?: 'sm' | 'lg' }) {
  const Icon = ICON[badge.icon];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-medium',
        size === 'lg' ? 'px-3 py-1.5 text-sm' : 'px-2.5 py-1 text-xs',
        TONE[badge.tone],
        className,
      )}
    >
      <Icon aria-hidden className={size === 'lg' ? 'size-4' : 'size-3.5'} />
      {badge.label}
    </span>
  );
}

import { History, Home, ListOrdered, Plus, Printer, Settings as Cog, WifiOff } from 'lucide-react';
import { Suspense } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { api } from '@/lib/api';
import { relative } from '@/lib/format';
import { useHubStatus, useJobs, useNow, useRealtimeSync } from '@/lib/queries';
import { isHubOnline } from '@/lib/status';
import { cn } from '@/lib/utils';
import { PageSkeleton } from './PageSkeleton';

const NAV = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/queue', label: 'Queue', icon: ListOrdered },
  { to: '/new', label: 'New print', icon: Plus, primary: true },
  { to: '/history', label: 'History', icon: History },
  { to: '/settings', label: 'Settings', icon: Cog },
] as const;

function HubOfflineBanner() {
  const { data: hub, isLoading } = useHubStatus();
  const now = useNow(5000);
  if (isLoading || isHubOnline(hub, now)) return null;
  return (
    <div role="alert" className="flex items-start gap-3 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm">
      <WifiOff aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
      <div>
        <p className="font-medium">Your home hub is offline. Prints won't start.</p>
        <p className="text-muted-foreground">
          {hub?.last_seen ? `Last seen ${relative(hub.last_seen, now)}.` : 'It has never connected.'} Check that it's
          powered and on Wi-Fi.
        </p>
      </div>
    </div>
  );
}

export function AppShell() {
  useRealtimeSync();
  const location = useLocation();
  const { data: jobs } = useJobs();
  const attention = jobs?.filter((j) => j.stage === 'attention' || j.stage === 'awaiting_clear').length ?? 0;

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[232px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r px-3 py-5 md:flex">
        <div className="mb-6 flex items-center gap-2 px-3">
          <div className="grid size-8 place-items-center rounded-lg bg-primary/15 text-primary">
            <Printer aria-hidden className="size-4.5" />
          </div>
          <span className="font-semibold tracking-tight">Print Scheduler</span>
        </div>
        <nav aria-label="Main" className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <NavLink
              key={to}
              to={to}
              end={'end' in rest}
              className={({ isActive }) =>
                cn(
                  'flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors',
                  isActive ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  'primary' in rest && !isActive && 'text-primary',
                )
              }
            >
              <Icon aria-hidden className="size-5" />
              {label}
              {to === '/' && attention > 0 && (
                <span className="ml-auto rounded-full bg-warning/20 px-2 text-xs text-warning" aria-label={`${attention} need you`}>
                  {attention}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {api.mode === 'demo' && (
          <p className="mt-auto rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
            Demo mode: simulated hub, nothing prints.
          </p>
        )}
      </aside>

      <div className="min-w-0">
        {api.mode === 'demo' && (
          <div className="bg-muted px-4 py-1.5 text-center text-xs text-muted-foreground md:hidden">
            Demo mode: simulated hub, nothing prints.
          </div>
        )}
        <main id="main" className="mx-auto w-full max-w-3xl px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-5 md:px-8 md:pb-12 md:pt-8">
          <div className="mb-4 empty:mb-0">
            <HubOfflineBanner />
          </div>
          {/* Subtle enter-only page transition (CSS; disabled by prefers-reduced-motion). */}
          <div key={location.pathname} className="animate-[page-in_160ms_ease-out]">
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-lg md:hidden"
      >
        <ul className="mx-auto grid max-w-md grid-cols-5">
          {NAV.map(({ to, label, icon: Icon, ...rest }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={'end' in rest}
                className={({ isActive }) =>
                  cn(
                    'relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium',
                    isActive ? 'text-foreground' : 'text-muted-foreground',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {'primary' in rest ? (
                      <span className="grid size-10 place-items-center rounded-full bg-primary text-primary-foreground shadow-md">
                        <Icon aria-hidden className="size-5" />
                      </span>
                    ) : (
                      <Icon aria-hidden className={cn('size-5', isActive && 'text-primary')} />
                    )}
                    <span className={cn('primary' in rest && 'sr-only')}>{label}</span>
                    {to === '/' && attention > 0 && (
                      <span className="absolute right-[calc(50%-18px)] top-3 size-2.5 rounded-full bg-warning ring-2 ring-background" aria-label={`${attention} need you`} />
                    )}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

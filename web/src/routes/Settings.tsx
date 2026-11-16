import { AlertTriangle, Bell, LogOut, Moon, Server, Sun } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { RelativeTime } from '@/components/RelativeTime';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Confirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useHubStatus, useNow, useSettings, useUpdateSettings } from '@/lib/queries';
import { isHubOnline, printerBadge } from '@/lib/status';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <h2 className="flex items-center gap-2 font-semibold">
          {icon}
          {title}
        </h2>
        {children}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { session } = useAuth();
  const { data: hub, isLoading: hubLoading } = useHubStatus();
  const { data: settings, isLoading } = useSettings();
  const update = useUpdateSettings();
  const now = useNow(5000);
  const online = isHubOnline(hub, now);
  const [theme, setTheme] = useTheme();


  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Section title="Home hub" icon={<Server aria-hidden className="size-5 text-muted-foreground" />}>
        {hubLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <StatusBadge
                badge={online ? { label: 'Online', tone: 'success', icon: 'done' } : { label: 'Offline', tone: 'danger', icon: 'offline' }}
              />
            </dd>
            <dt className="text-muted-foreground">Last seen</dt>
            <dd>{hub?.last_seen ? <RelativeTime date={hub.last_seen} /> : 'Never'}</dd>
            <dt className="text-muted-foreground">Printer</dt>
            <dd>{printerBadge(hub, online).label}</dd>
            <dt className="text-muted-foreground">Version</dt>
            <dd className="tabular">{hub?.hub_version ?? '—'}</dd>
            <dt className="text-muted-foreground">Last error</dt>
            <dd className={cn('break-words', hub?.last_error ? 'text-danger' : 'text-muted-foreground')}>
              {hub?.last_error ?? 'None'}
            </dd>
          </dl>
        )}
      </Section>

      <Section title="Scheduling" icon={<AlertTriangle aria-hidden className="size-5 text-muted-foreground" />}>
        {isLoading || !settings ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            <LateMinForm key={settings.max_late_min} current={settings.max_late_min} />

            <div className="flex items-start justify-between gap-4 border-t pt-4">
              <div>
                <Label htmlFor="auto">Auto-continue</Label>
                <p className="text-sm text-muted-foreground">
                  Skip “Plate is clear” after each print, so the next job can start on its own.
                </p>
              </div>
              {settings.auto_continue ? (
                <Switch id="auto" checked onCheckedChange={() => update.mutate({ auto_continue: false })} />
              ) : (
                <Confirm
                  title="Turn on auto-continue?"
                  description={
                    <div className="space-y-2">
                      <p>
                        The next print will start <strong>on top of whatever is on the plate</strong> unless something removes
                        it. Only use this if parts are removed automatically or you only queue one print at a time.
                      </p>
                      <p>A collision can damage the printer or start a fire.</p>
                    </div>
                  }
                  confirmLabel="Turn on"
                  cancelLabel="Keep off"
                  tone="warning"
                  onConfirm={() => update.mutateAsync({ auto_continue: true }).then(() => undefined)}
                >
                  <Switch id="auto" checked={false} />
                </Confirm>
              )}
            </div>
            {settings.auto_continue && (
              <p role="alert" className="flex gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                Auto-continue is on. Queued prints will start back to back without checking the plate.
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Notifications" icon={<Bell aria-hidden className="size-5 text-muted-foreground" />}>
        {isLoading || !settings ? (
          <Skeleton className="h-24" />
        ) : (
          <TopicForm key={settings.ntfy_topic ?? ''} current={settings.ntfy_topic} />
        )}
      </Section>

      <Section title="Appearance" icon={theme === 'dark' ? <Moon aria-hidden className="size-5 text-muted-foreground" /> : <Sun aria-hidden className="size-5 text-muted-foreground" />}>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2">
          {(['dark', 'light'] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              onClick={() => setTheme(t)}
              className={cn(
                'flex h-12 items-center justify-center gap-2 rounded-xl border text-sm font-medium capitalize',
                theme === t ? 'border-primary bg-primary/15 text-primary' : 'hover:bg-muted',
              )}
            >
              {t === 'dark' ? <Moon aria-hidden className="size-4" /> : <Sun aria-hidden className="size-4" />}
              {t}
            </button>
          ))}
        </div>
      </Section>

      <Card>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Signed in as</p>
            <p className="truncate font-medium">{session?.email ?? '—'}</p>
          </div>
          <Button variant="outline" onClick={() => void api.signOut()}>
            <LogOut aria-hidden /> Sign out
          </Button>
        </CardContent>
      </Card>

      <p className="px-1 text-xs text-muted-foreground">
        Unattended printing is a fire risk. Keep a smoke detector near the printer and, ideally, a smart plug you can switch off
        remotely.
      </p>
    </div>
  );
}

function LateMinForm({ current }: { current: number }) {
  const update = useUpdateSettings();
  const [lateMin, setLateMin] = useState(String(current));
  const lateValue = Number(lateMin);
  const lateValid = Number.isInteger(lateValue) && lateValue >= 1 && lateValue <= 1440;
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (lateValid) update.mutate({ max_late_min: lateValue });
      }}
    >
      <Label htmlFor="late">Give up on a print if it can't start within</Label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id="late"
            type="number"
            inputMode="numeric"
            min={1}
            max={1440}
            value={lateMin}
            onChange={(e) => setLateMin(e.target.value)}
            aria-invalid={!lateValid}
            aria-describedby="late-help"
            className="pr-20"
          />
          <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">minutes</span>
        </div>
        <Button type="submit" variant="secondary" size="lg" disabled={!lateValid || lateValue === current}>
          Save
        </Button>
      </div>
      <p id="late-help" className="text-sm text-muted-foreground">
        After this long past its time (for example, waiting for the plate), a job is marked missed instead of starting
        later than you expected. 1–1440.
      </p>
    </form>
  );
}

function TopicForm({ current }: { current: string | null }) {
  const update = useUpdateSettings();
  const [topic, setTopic] = useState(current ?? '');
  const topicValid = topic === '' || /^[A-Za-z0-9_-]{1,64}$/.test(topic);

  const sendTest = async () => {
    try {
      const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        body: 'Test from your print scheduler. Notifications work.',
        headers: { Title: 'Print scheduler' },
      });
      if (!r.ok) throw new Error(String(r.status));
      toast.success('Test sent. Check the ntfy app.');
    } catch {
      toast.error("Couldn't reach ntfy.sh. Check your connection and the topic name.");
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (topicValid) update.mutate({ ntfy_topic: topic || null });
      }}
    >
      <Label htmlFor="topic">ntfy.sh topic</Label>
      <div className="flex gap-2">
        <Input
          id="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value.trim())}
          placeholder="e.g. my-printer-k39x7q"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={!topicValid}
          aria-describedby="topic-help"
        />
        <Button type="submit" variant="secondary" size="lg" disabled={!topicValid || topic === (current ?? '')}>
          Save
        </Button>
      </div>
      <p id="topic-help" className={cn('text-sm', topicValid ? 'text-muted-foreground' : 'text-danger')}>
        {topicValid
          ? 'Subscribe to this topic in the ntfy app to get alerts when a print finishes, needs attention, or is waiting for the plate. Anyone who knows the topic can read it, so make it hard to guess.'
          : 'Use only letters, numbers, - and _ (max 64).'}
      </p>
      {current && (
        <Button type="button" variant="ghost" size="sm" onClick={sendTest}>
          Send a test notification
        </Button>
      )}
    </form>
  );
}

import { m, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CalendarPlus, FileUp, Info, Loader2, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AmsMapper } from '@/components/AmsMapper';
import { SchedulePicker } from '@/components/SchedulePicker';
import { resolveChoice, type ScheduleChoice } from '@/lib/schedule';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Confirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MAX_UPLOAD_BYTES } from '@/lib/api';
import { clockTime, displayName, formatBytes, formatDuration } from '@/lib/format';
import { useCreateJob, useJobs, useNow } from '@/lib/queries';
import type { PrintFileInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

type Parsed = { file: File; info: PrintFileInfo; thumbUrl: string | null };

export default function NewPrint() {
  const navigate = useNavigate();
  const now = useNow(15_000);
  const { data: jobs = [] } = useJobs();
  const create = useCreateJob();
  const reduce = useReducedMotion();

  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'now' });
  const [useAms, setUseAms] = useState(false);
  const [mapping, setMapping] = useState<number[]>([]);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => () => {
    if (parsed?.thumbUrl) URL.revokeObjectURL(parsed.thumbUrl);
  }, [parsed]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setParsed(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `That file is ${(file.size / 1048576).toFixed(0)} MB, over the ${MAX_UPLOAD_BYTES / 1048576} MB limit. ` +
          'Try fewer objects on the plate, or check your Supabase storage limit.',
      );
      return;
    }
    setParsing(true);
    try {
      const { parseThreeMf, defaultAmsMapping } = await import('@/lib/threemf');
      const info = await parseThreeMf(file);
      setParsed({ file, info, thumbUrl: info.thumbnail ? URL.createObjectURL(info.thumbnail) : null });
      setName(displayName(file.name));
      setUseAms(info.usesAms);
      setMapping(defaultAmsMapping(info.filaments.map((f) => f.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const submit = async () => {
    if (!parsed) return;
    const runAt = resolveChoice(choice);
    setProgress(0);
    try {
      await create.mutateAsync({
        input: {
          id: crypto.randomUUID(),
          file: parsed.file,
          name: name.trim() || displayName(parsed.file.name),
          thumbnail: parsed.info.thumbnail,
          runAt,
          useAms,
          amsMapping: useAms ? mapping : [],
          estSeconds: parsed.info.estSeconds,
          filamentG: parsed.info.filamentG,
          filamentType: parsed.info.filamentTypes.join(', ') || null,
        },
        onProgress: setProgress,
      });
      toast.success(choice.kind === 'now' ? 'Sent. It will start as soon as the printer is ready.' : `Scheduled for ${clockTime(runAt)}`);
      navigate(choice.kind === 'now' ? '/' : '/queue');
    } catch (e) {
      setProgress(null);
      toast.error((e as Error).message);
    }
  };

  const uploading = progress !== null;
  const inPast = choice.kind === 'at' && choice.at.getTime() < now - 60_000;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">New print</h1>

      {!parsed ? (
          <div>
            <DropZone onFile={pick} busy={parsing} />
            {error && (
              <div role="alert" className="mt-4 flex gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm">
                <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
                <p>{error}</p>
              </div>
            )}
          </div>
        ) : (
          <m.div
            key="form"
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-5"
          >
            <Card>
              <CardContent className="flex gap-4">
                <div className="grid size-28 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted">
                  {parsed.thumbUrl ? (
                    <img src={parsed.thumbUrl} alt="Plate preview" className="size-full object-cover" />
                  ) : (
                    <span className="text-xs text-muted-foreground">No preview</span>
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor="job-name" className="sr-only">Name</Label>
                    <Input id="job-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className="h-10 font-medium" />
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Print time</dt>
                    <dd className="tabular">{formatDuration(parsed.info.estSeconds)}</dd>
                    <dt className="text-muted-foreground">Filament</dt>
                    <dd className="tabular">
                      {parsed.info.filamentG != null ? `${parsed.info.filamentG.toFixed(0)} g` : '—'}
                      {parsed.info.filamentTypes.length > 0 && ` · ${parsed.info.filamentTypes.join(', ')}`}
                    </dd>
                    <dt className="text-muted-foreground">File</dt>
                    <dd className="tabular">{formatBytes(parsed.file.size)}</dd>
                  </dl>
                </div>
              </CardContent>
              {parsed.info.warnings.length > 0 && (
                <ul className="space-y-1 border-t px-5 py-3 text-sm text-muted-foreground">
                  {parsed.info.warnings.map((w) => (
                    <li key={w} className="flex gap-2">
                      <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> {w}
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t px-5 py-2">
                <Button variant="ghost" size="sm" onClick={() => setParsed(null)} disabled={uploading}>
                  <RefreshCw aria-hidden /> Choose a different file
                </Button>
              </div>
            </Card>

            {parsed.info.filaments.length > 0 && (
              <Card>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label htmlFor="use-ams">Use AMS</Label>
                      <p className="text-sm text-muted-foreground">
                        {parsed.info.filaments.length > 1 ? 'This print uses more than one filament.' : 'Feed filament from the AMS lite.'}
                      </p>
                    </div>
                    <Switch id="use-ams" checked={useAms} onCheckedChange={setUseAms} />
                  </div>
                  {useAms && <AmsMapper filaments={parsed.info.filaments} mapping={mapping} onChange={setMapping} />}
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="space-y-4">
                <h2 className="font-semibold">When</h2>
                <SchedulePicker value={choice} onChange={setChoice} estSeconds={parsed.info.estSeconds} jobs={jobs} now={now} />
              </CardContent>
            </Card>

            <div className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 text-sm">
              <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
              <p>
                <strong>Before it starts:</strong> the build plate must be empty and the right filament loaded. Nothing
                prints until you've confirmed the plate is clear in this app.
              </p>
            </div>

            {uploading && (
              <div className="space-y-2" role="status" aria-live="polite">
                <div className="flex justify-between text-sm">
                  <span>Uploading…</span>
                  <span className="tabular">{Math.round((progress ?? 0) * 100)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(progress ?? 0) * 100}%` }} />
                </div>
              </div>
            )}

            {choice.kind === 'now' ? (
              <Confirm
                title="Print now?"
                description="It starts as soon as the printer is idle and the plate is confirmed clear. Make sure the plate is empty and filament is loaded."
                confirmLabel="Print now"
                cancelLabel="Not yet"
                tone="default"
                onConfirm={submit}
              >
                <Button size="xl" className="w-full" disabled={uploading || !name.trim()}>
                  {uploading ? <Loader2 aria-hidden className="animate-spin" /> : <Play aria-hidden />}
                  Print now
                </Button>
              </Confirm>
            ) : (
              <Button size="xl" className="w-full" onClick={submit} disabled={uploading || inPast || !name.trim()}>
                {uploading ? <Loader2 aria-hidden className="animate-spin" /> : <CalendarPlus aria-hidden />}
                Schedule for {clockTime(choice.at, now)}
              </Button>
            )}
          </m.div>
        )}
    </div>
  );
}

function DropZone({ onFile, busy }: { onFile: (f: File | undefined) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    onFile(e.dataTransfer.files[0]);
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors',
        over ? 'border-primary bg-primary/10' : 'border-border',
      )}
    >
      <div className="grid size-14 place-items-center rounded-full bg-primary/15 text-primary">
        {busy ? <Loader2 aria-hidden className="size-7 animate-spin" /> : <FileUp aria-hidden className="size-7" />}
      </div>
      <div>
        <p className="font-medium">{busy ? 'Reading file…' : 'Drop a sliced .gcode.3mf here'}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          In Bambu Studio: slice, then File → Export → Export plate sliced file.
        </p>
      </div>
      <Button size="lg" onClick={() => input.current?.click()} disabled={busy}>
        Choose file
      </Button>
      <input
        ref={input}
        type="file"
        accept=".3mf,application/vnd.ms-package.3dmanufacturing-3dmodel+xml,model/3mf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose a .gcode.3mf file"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

import { Loader2, Mail, Printer } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function Login() {
  const { session, loading } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkSent, setLinkSent] = useState(false);

  if (!loading && session) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.signIn(email.trim(), password);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const magic = async () => {
    if (!email.trim()) {
      setError('Enter your email first, then tap “Email me a link”.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.sendMagicLink(email.trim());
      setLinkSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-primary/15 text-primary">
            <Printer aria-hidden className="size-7" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Print Scheduler</h1>
          <p className="text-sm text-muted-foreground">Sign in to manage your printer.</p>
        </div>

        {linkSent ? (
          <div role="status" className="rounded-2xl border bg-card p-5 text-center text-sm">
            <Mail aria-hidden className="mx-auto mb-3 size-6 text-primary" />
            Check <span className="font-medium">{email}</span> for a sign-in link.
            <Button variant="ghost" className="mt-3 w-full" onClick={() => setLinkSent(false)}>
              Back
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'login-error' : undefined}
              />
            </div>
            {error && (
              <p id="login-error" role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" className="w-full" disabled={busy || !email || !password}>
              {busy && <Loader2 aria-hidden className="animate-spin" />}
              Sign in
            </Button>
            <Button type="button" variant="ghost" className="w-full text-muted-foreground" onClick={magic} disabled={busy}>
              Email me a link instead
            </Button>
          </form>
        )}
        {api.mode === 'demo' && (
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Demo mode: any email and a 4+ character password.
          </p>
        )}
      </div>
    </main>
  );
}

import { lazy, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/AppShell';
import { PageSkeleton } from './components/PageSkeleton';
import { Button } from './components/ui/button';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { useTheme } from './lib/theme';
import Login from './routes/Login';
import Dashboard from './routes/Dashboard';

// Code-split everything except the first screen.
const NewPrint = lazy(() => import('./routes/NewPrint'));
const Queue = lazy(() => import('./routes/Queue'));
const History = lazy(() => import('./routes/History'));
const Settings = lazy(() => import('./routes/Settings'));

function RequireOwner({ children }: { children: ReactNode }) {
  const { loading, session, role } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageSkeleton />
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role !== 'owner') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">This account can't use the app</h1>
        <p className="text-sm text-muted-foreground">
          {role === 'hub'
            ? 'This is the hub\'s device account. Sign in with your own account.'
            : 'Your account isn\'t set up as the owner. Add it to the members table (see README).'}
        </p>
        <Button variant="secondary" onClick={() => void api.signOut()}>
          Sign out
        </Button>
      </div>
    );
  }
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: (
      <RequireOwner>
        <AppShell />
      </RequireOwner>
    ),
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'new', element: <NewPrint /> },
      { path: 'queue', element: <Queue /> },
      { path: 'history', element: <History /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  const [theme] = useTheme();
  return (
    <>
      <RouterProvider router={router} />
      <Toaster
        theme={theme}
        position="top-center"
        richColors
        closeButton
        toastOptions={{ className: 'rounded-xl' }}
        offset={{ top: 'max(16px, env(safe-area-inset-top))' }}
      />
    </>
  );
}

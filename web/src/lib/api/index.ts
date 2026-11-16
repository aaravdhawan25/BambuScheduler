import type { Api } from './api';
import { DemoApi } from './demoApi';
import { SupabaseApi } from './supabaseApi';

export * from './api';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const demo = import.meta.env.VITE_DEMO === '1' || !url || !key;

export const api: Api = demo ? new DemoApi() : new SupabaseApi(url!, key!);

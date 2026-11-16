// Read-only smoke test of RLS against your REAL Supabase project.
// Every check attempts something forbidden and expects it to fail, so nothing changes.
//
//   cd supabase/tests
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... HUB_EMAIL=... HUB_PASSWORD=... node live-smoke.mjs
//
// (Uses the hub's credentials from hub/.env. Never pass a service-role key.)
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL: url, SUPABASE_ANON_KEY: key, HUB_EMAIL, HUB_PASSWORD } = process.env;
if (!url || !key || !HUB_EMAIL || !HUB_PASSWORD) {
  console.error('Set SUPABASE_URL, SUPABASE_ANON_KEY, HUB_EMAIL, HUB_PASSWORD');
  process.exit(2);
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
let failures = 0;

async function expectBlocked(label, fn) {
  const { data, error, count } = await fn();
  const rows = Array.isArray(data) ? data.length : data ? 1 : 0;
  const blocked = !!error || (rows === 0 && !count);
  console.log(`${blocked ? 'PASS' : 'FAIL'}  ${label}${error ? `  (${error.message})` : ''}`);
  if (!blocked) failures++;
}

const anon = createClient(url, key, opts);
console.log('--- unauthenticated (anon key) ---');
for (const t of ['jobs', 'commands', 'hub_status', 'settings', 'members']) {
  await expectBlocked(`anon cannot read ${t}`, () => anon.from(t).select('*'));
}
await expectBlocked('anon cannot send a command', () => anon.from('commands').insert({ action: 'stop' }).select());
await expectBlocked('anon cannot set plate_clear', () => anon.from('hub_status').update({ plate_clear: true }).eq('id', 1).select());
await expectBlocked('anon cannot list stored files', () => anon.storage.from('prints').list());

const hub = createClient(url, key, opts);
const { error: loginErr } = await hub.auth.signInWithPassword({ email: HUB_EMAIL, password: HUB_PASSWORD });
if (loginErr) {
  console.error('Hub sign-in failed:', loginErr.message);
  process.exit(2);
}
console.log('--- hub device account ---');
const { data: roleRow } = await hub.rpc('my_role');
console.log(`info  hub role is ${JSON.stringify(roleRow)}`);
await expectBlocked('hub cannot create a job', () =>
  hub.from('jobs').insert({ name: 'x', storage_path: 'x/y/z.gcode.3mf' }).select());
await expectBlocked('hub cannot delete jobs', () => hub.from('jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000').select());
await expectBlocked('hub cannot change when a job runs', () =>
  hub.from('jobs').update({ run_at: new Date().toISOString() }).eq('stage', 'pending').select());
await expectBlocked('hub cannot change settings', () => hub.from('settings').update({ auto_continue: true }).eq('id', 1).select());
await expectBlocked('hub cannot send commands', () => hub.from('commands').insert({ action: 'stop' }).select());
await expectBlocked("hub cannot read the owner's membership", () => hub.from('members').select('*').neq('role', 'hub'));
await expectBlocked('hub cannot upload files', () =>
  hub.storage.from('prints').upload(`smoke/${Date.now()}.txt`, new Blob(['x'])));

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

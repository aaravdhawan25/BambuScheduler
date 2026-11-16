/**
 * Proves the RLS boundary: what anon, a stranger (signed in, no membership),
 * the owner, and the hub device can and cannot do.
 *
 * Runs the real migrations on PGlite (Postgres compiled to WASM) on top of a
 * small Supabase shim (supabase_shim.sql). Run: `npm test` in supabase/tests.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const OWNER = '11111111-1111-1111-1111-111111111111';
const HUB = '22222222-2222-2222-2222-222222222222';
const STRANGER = '33333333-3333-3333-3333-333333333333';

type Who = 'anon' | typeof OWNER | typeof HUB | typeof STRANGER;
type Result = { rows: Record<string, unknown>[]; affected: number; error?: string };

const here = import.meta.dirname;
const migrationsDir = join(here, '..', 'migrations');

let db: PGlite;

async function as(who: Who, sql: string, params: unknown[] = []): Promise<Result> {
  await db.exec('begin');
  try {
    if (who === 'anon') {
      await db.exec(`set local role anon; select set_config('request.jwt.claim.sub', '', true);`);
    } else {
      await db.exec(
        `set local role authenticated; select set_config('request.jwt.claim.sub', '${who}', true);`,
      );
    }
    const r = await db.query<Record<string, unknown>>(sql, params);
    await db.exec('commit');
    return { rows: r.rows, affected: r.affectedRows ?? 0 };
  } catch (e) {
    await db.exec('rollback');
    return { rows: [], affected: 0, error: (e as Error).message };
  }
}

/** Run as the postgres superuser (setup / verification). */
async function admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await db.query<T>(sql, params)).rows;
}

/** A forbidden write either errors or touches zero rows. */
function expectBlocked(r: Result) {
  if (!r.error) expect(r.affected).toBe(0);
}

async function insertJob(fields: Record<string, unknown> = {}) {
  const id = (fields.id as string) ?? crypto.randomUUID();
  const f = {
    id,
    owner_id: OWNER,
    name: 'Benchy',
    storage_path: `${OWNER}/${id}/benchy.gcode.3mf`,
    stage: 'pending',
    ...fields,
  };
  const cols = Object.keys(f);
  await admin(
    `insert into public.jobs (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(f),
  );
  return id;
}

async function jobRow(id: string) {
  return (await admin(`select * from public.jobs where id = $1`, [id]))[0];
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(here, 'supabase_shim.sql'), 'utf8'));
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(migrationsDir, f), 'utf8'));
  }
  await db.exec(`
    insert into auth.users (id, email) values
      ('${OWNER}', 'me@example.com'),
      ('${HUB}', 'hub@example.com'),
      ('${STRANGER}', 'stranger@example.com');
    insert into public.members (user_id, role) values ('${OWNER}', 'owner'), ('${HUB}', 'hub');
  `);
});

describe('unauthenticated (anon key only)', () => {
  it.each(['jobs', 'commands', 'hub_status', 'settings', 'members'])('cannot read %s', async (t) => {
    const r = await as('anon', `select * from public.${t}`);
    expect(r.error ?? '').toMatch(/permission denied/);
  });

  it('cannot create jobs or commands', async () => {
    const id = crypto.randomUUID();
    expect(
      (
        await as(
          'anon',
          `insert into public.jobs (owner_id, name, storage_path) values ($1, 'x', $2)`,
          [OWNER, `${OWNER}/${id}/x.gcode.3mf`],
        )
      ).error,
    ).toMatch(/permission denied/);
    expect((await as('anon', `insert into public.commands (action) values ('stop')`)).error).toMatch(
      /permission denied/,
    );
  });

  it('cannot change hub_status or settings', async () => {
    expectBlocked(await as('anon', `update public.hub_status set plate_clear = true`));
    expectBlocked(await as('anon', `update public.settings set auto_continue = true`));
    expect((await admin(`select plate_clear from public.hub_status`))[0].plate_clear).toBe(false);
  });

  it('cannot read or write stored files', async () => {
    await admin(`insert into storage.objects (bucket_id, name) values ('prints', $1)`, [
      `${OWNER}/a/file.gcode.3mf`,
    ]);
    expect((await as('anon', `select * from storage.objects`)).rows).toHaveLength(0);
    expect(
      (await as('anon', `insert into storage.objects (bucket_id, name) values ('prints', 'x/y.3mf')`)).error,
    ).toBeTruthy();
  });

  it('cannot call role helpers', async () => {
    expect((await as('anon', `select public.my_role()`)).error).toMatch(/permission denied/);
  });
});

describe('signed-in stranger (no membership row)', () => {
  it('sees nothing', async () => {
    await insertJob();
    for (const t of ['jobs', 'commands', 'hub_status', 'settings', 'members']) {
      const r = await as(STRANGER, `select * from public.${t}`);
      expect(r.error).toBeUndefined();
      expect(r.rows, t).toHaveLength(0);
    }
  });

  it('cannot create jobs or commands, or touch hub state', async () => {
    const id = crypto.randomUUID();
    expect(
      (
        await as(STRANGER, `insert into public.jobs (id, name, storage_path) values ($1, 'x', $2)`, [
          id,
          `${STRANGER}/${id}/x.gcode.3mf`,
        ])
      ).error,
    ).toMatch(/row-level security/);
    expect((await as(STRANGER, `insert into public.commands (action) values ('stop')`)).error).toMatch(
      /row-level security/,
    );
    expectBlocked(await as(STRANGER, `update public.hub_status set plate_clear = true`));
    expect((await as(STRANGER, `insert into public.members (user_id, role) values ($1, 'owner')`, [STRANGER])).error).toBeTruthy();
  });

  it('cannot upload to the bucket', async () => {
    const r = await as(STRANGER, `insert into storage.objects (bucket_id, name) values ('prints', $1)`, [
      `${STRANGER}/x/y.gcode.3mf`,
    ]);
    expect(r.error).toMatch(/row-level security/);
  });
});

describe('owner', () => {
  it('creates a pending job in their own folder', async () => {
    const id = crypto.randomUUID();
    const r = await as(
      OWNER,
      `insert into public.jobs (id, name, storage_path, run_at) values ($1, 'Benchy', $2, now()) returning stage, owner_id`,
      [id, `${OWNER}/${id}/benchy.gcode.3mf`],
    );
    expect(r.error).toBeUndefined();
    expect(r.rows[0]).toMatchObject({ stage: 'pending', owner_id: OWNER });
  });

  it('cannot create a job that is already printing or points at someone else\'s folder', async () => {
    const id = crypto.randomUUID();
    expect(
      (
        await as(OWNER, `insert into public.jobs (id, name, storage_path, stage) values ($1, 'x', $2, 'printing')`, [
          id,
          `${OWNER}/${id}/x.gcode.3mf`,
        ])
      ).error,
    ).toMatch(/row-level security/);
    expect(
      (
        await as(OWNER, `insert into public.jobs (id, name, storage_path) values ($1, 'x', $2)`, [
          id,
          `${HUB}/${id}/x.gcode.3mf`,
        ])
      ).error,
    ).toMatch(/row-level security/);
  });

  it('reschedules and cancels pending jobs; cancel stamps finished_at', async () => {
    const id = await insertJob();
    expect((await as(OWNER, `update public.jobs set run_at = now() + interval '1 day' where id = $1`, [id])).affected).toBe(1);
    expect((await as(OWNER, `update public.jobs set stage = 'cancelled' where id = $1`, [id])).affected).toBe(1);
    const row = await jobRow(id);
    expect(row.stage).toBe('cancelled');
    expect(row.finished_at).not.toBeNull();
  });

  it('cannot force a job into printing/done or edit hub-owned fields', async () => {
    const id = await insertJob();
    for (const sql of [
      `update public.jobs set stage = 'printing' where id = $1`,
      `update public.jobs set stage = 'done' where id = $1`,
      `update public.jobs set remote_name = 'x.gcode.3mf' where id = $1`,
      `update public.jobs set started_at = now() where id = $1`,
      `update public.jobs set storage_path = 'elsewhere' where id = $1`,
      `update public.jobs set owner_id = '${HUB}' where id = $1`,
    ]) {
      expect((await as(OWNER, sql, [id])).error, sql).toBeTruthy();
    }
  });

  it('cannot reschedule or cancel a job that is printing', async () => {
    const id = await insertJob({ stage: 'printing' });
    expect((await as(OWNER, `update public.jobs set run_at = now() where id = $1`, [id])).error).toBeTruthy();
    expect((await as(OWNER, `update public.jobs set stage = 'cancelled' where id = $1`, [id])).error).toBeTruthy();
  });

  it('can dismiss an attention job by cancelling it', async () => {
    const id = await insertJob({ stage: 'attention' });
    expect((await as(OWNER, `update public.jobs set stage = 'cancelled' where id = $1`, [id])).affected).toBe(1);
  });

  it('deletes only finished jobs', async () => {
    const pending = await insertJob();
    const done = await insertJob({ stage: 'done' });
    expect((await as(OWNER, `delete from public.jobs where id = $1`, [pending])).affected).toBe(0);
    expect((await as(OWNER, `delete from public.jobs where id = $1`, [done])).affected).toBe(1);
  });

  it('sends commands but cannot mark them handled', async () => {
    const r = await as(OWNER, `insert into public.commands (action) values ('pause') returning id, status`);
    expect(r.rows[0].status).toBe('pending');
    expect(
      (await as(OWNER, `insert into public.commands (action, status) values ('stop', 'done')`)).error,
    ).toMatch(/row-level security/);
    expectBlocked(await as(OWNER, `update public.commands set status = 'done' where id = $1`, [r.rows[0].id]));
  });

  it('cannot write hub_status (plate_clear goes through a command)', async () => {
    expectBlocked(await as(OWNER, `update public.hub_status set plate_clear = true`));
    expect((await as(OWNER, `select plate_clear from public.hub_status`)).rows[0].plate_clear).toBe(false);
  });

  it('edits settings within limits', async () => {
    expect((await as(OWNER, `update public.settings set max_late_min = 30, ntfy_topic = 'my-printer_42'`)).affected).toBe(1);
    expect((await as(OWNER, `update public.settings set ntfy_topic = 'bad topic!'`)).error).toMatch(/check constraint/);
    expect((await as(OWNER, `update public.settings set max_late_min = 0`)).error).toMatch(/check constraint/);
  });

  it('sees only their own membership row', async () => {
    const r = await as(OWNER, `select user_id from public.members`);
    expect(r.rows).toEqual([{ user_id: OWNER }]);
    expect((await as(OWNER, `select public.my_role() as r`)).rows[0].r).toBe('owner');
  });

  it('uploads only into their own storage folder', async () => {
    expect(
      (await as(OWNER, `insert into storage.objects (bucket_id, name) values ('prints', $1)`, [`${OWNER}/j/a.gcode.3mf`])).error,
    ).toBeUndefined();
    expect(
      (await as(OWNER, `insert into storage.objects (bucket_id, name) values ('prints', $1)`, [`${HUB}/j/a.gcode.3mf`])).error,
    ).toMatch(/row-level security/);
    expect((await as(OWNER, `select name from storage.objects`)).rows).toHaveLength(1);
  });
});

describe('hub device account', () => {
  it('reads jobs, settings, commands, and hub_status', async () => {
    await insertJob();
    await admin(`insert into public.commands (action, created_by) values ('pause', $1)`, [OWNER]);
    for (const t of ['jobs', 'settings', 'commands', 'hub_status']) {
      expect((await as(HUB, `select * from public.${t}`)).rows.length, t).toBe(1);
    }
  });

  it("cannot read the owner's membership row", async () => {
    expect((await as(HUB, `select user_id from public.members`)).rows).toEqual([{ user_id: HUB }]);
  });

  it('cannot create or delete jobs', async () => {
    const id = crypto.randomUUID();
    expect(
      (
        await as(HUB, `insert into public.jobs (id, owner_id, name, storage_path) values ($1, $2, 'x', $3)`, [
          id,
          OWNER,
          `${OWNER}/${id}/x.gcode.3mf`,
        ])
      ).error,
    ).toMatch(/row-level security/);
    const existing = await insertJob({ stage: 'done' });
    expect((await as(HUB, `delete from public.jobs where id = $1`, [existing])).affected).toBe(0);
    expect(await jobRow(existing)).toBeDefined();
  });

  it('claims a pending job atomically: the second claim changes nothing', async () => {
    const id = await insertJob();
    const claim = `update public.jobs set stage = 'uploading' where id = $1 and stage = 'pending' returning id`;
    expect((await as(HUB, claim, [id])).rows).toHaveLength(1);
    expect((await as(HUB, claim, [id])).rows).toHaveLength(0);
  });

  it('walks the happy path of stages', async () => {
    const id = await insertJob();
    for (const [stage, extra] of [
      ['uploading', ''],
      ['printing', ', started_at = now(), remote_name = \'sched_x.gcode.3mf\''],
      ['awaiting_clear', ', finished_at = now()'],
      ['done', ''],
    ] as const) {
      const r = await as(HUB, `update public.jobs set stage = '${stage}'${extra} where id = $1`, [id]);
      expect(r.error, stage).toBeUndefined();
      expect(r.affected, stage).toBe(1);
    }
  });

  it('cannot make illegal stage jumps', async () => {
    const pending = await insertJob();
    expect((await as(HUB, `update public.jobs set stage = 'done' where id = $1`, [pending])).error).toMatch(/may not move/);
    expect((await as(HUB, `update public.jobs set stage = 'cancelled' where id = $1`, [pending])).error).toMatch(/may not move/);
    const printing = await insertJob({ stage: 'printing' });
    expect((await as(HUB, `update public.jobs set stage = 'pending' where id = $1`, [printing])).error).toMatch(/may not move/);
  });

  it('cannot change what or when to print', async () => {
    const id = await insertJob();
    for (const sql of [
      `update public.jobs set run_at = now() - interval '1 hour' where id = $1`,
      `update public.jobs set name = 'other' where id = $1`,
      `update public.jobs set storage_path = 'other/path' where id = $1`,
      `update public.jobs set ams_mapping = '{1,2}' where id = $1`,
      `update public.jobs set owner_id = '${HUB}' where id = $1`,
    ]) {
      expect((await as(HUB, sql, [id])).error, sql).toMatch(/hub may only change/);
    }
  });

  it('handles commands once and cannot rewrite them', async () => {
    const [{ id }] = await admin<{ id: number }>(
      `insert into public.commands (action, created_by) values ('pause', $1) returning id`,
      [OWNER],
    );
    expect(
      (await as(HUB, `update public.commands set status = 'done', handled_at = now(), result = 'ok' where id = $1`, [id])).affected,
    ).toBe(1);
    expect((await as(HUB, `update public.commands set status = 'failed' where id = $1`, [id])).error).toMatch(/already handled/);
    const [{ id: id2 }] = await admin<{ id: number }>(
      `insert into public.commands (action, created_by) values ('pause', $1) returning id`,
      [OWNER],
    );
    expect((await as(HUB, `update public.commands set action = 'stop' where id = $1`, [id2])).error).toMatch(/hub may only change/);
    expect((await as(HUB, `insert into public.commands (action) values ('stop')`)).error).toMatch(/row-level security/);
  });

  it('writes hub_status; last_seen comes from the database clock', async () => {
    const r = await as(
      HUB,
      `insert into public.hub_status (id, plate_clear, state, last_seen) values (1, true, 'IDLE', '2000-01-01')
       on conflict (id) do update set plate_clear = excluded.plate_clear, state = excluded.state, last_seen = excluded.last_seen
       returning last_seen`,
    );
    expect(r.error).toBeUndefined();
    expect(new Date(r.rows[0].last_seen as string).getFullYear()).toBeGreaterThan(2000);
  });

  it('cannot change settings', async () => {
    expectBlocked(await as(HUB, `update public.settings set auto_continue = true`));
    expect((await admin(`select auto_continue from public.settings`))[0].auto_continue).toBe(false);
  });

  it('downloads print files but cannot upload', async () => {
    await admin(`insert into storage.objects (bucket_id, name) values ('prints', $1)`, [`${OWNER}/j/a.gcode.3mf`]);
    expect((await as(HUB, `select name from storage.objects`)).rows).toHaveLength(1);
    expect(
      (await as(HUB, `insert into storage.objects (bucket_id, name) values ('prints', $1)`, [`${HUB}/j/a.gcode.3mf`])).error,
    ).toMatch(/row-level security/);
  });

  it('deletes a stored file only when its job finished more than 7 days ago', async () => {
    const fresh = await insertJob({ stage: 'done', finished_at: new Date().toISOString() });
    const old = await insertJob({ stage: 'done', finished_at: new Date(Date.now() - 8 * 864e5).toISOString() });
    const pendingOld = await insertJob({ stage: 'pending', run_at: new Date(Date.now() - 8 * 864e5).toISOString() });
    for (const id of [fresh, old, pendingOld]) {
      await admin(`insert into storage.objects (bucket_id, name) values ('prints', $1)`, [
        `${OWNER}/${id}/benchy.gcode.3mf`,
      ]);
    }
    const del = (id: string) =>
      as(HUB, `delete from storage.objects where name = $1`, [`${OWNER}/${id}/benchy.gcode.3mf`]);
    expect((await del(fresh)).affected).toBe(0);
    expect((await del(pendingOld)).affected).toBe(0);
    expect((await del(old)).affected).toBe(1);
    expect((await as(HUB, `update public.jobs set file_purged_at = now() where id = $1`, [old])).affected).toBe(1);
  });
});

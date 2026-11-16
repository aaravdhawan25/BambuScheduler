-- Bambu print scheduler: schema, row level security, storage policies.
--
-- Security model (see README "Security"):
--   * The browser only ever has the anon key, so RLS is the security boundary.
--   * Every signed-in user must have a row in `members` with role 'owner' or 'hub'.
--     Users without a membership row can read/write nothing.
--   * The hub is a device account. It can read jobs/settings/commands, advance
--     job stages along a fixed set of transitions, update commands, and write
--     hub_status. It can never insert or delete jobs, or edit what/when to print.
--   * Triggers enforce column-level and transition rules that RLS alone can't.

-------------------------------------------------------------------------------
-- Members and role helpers
-------------------------------------------------------------------------------

create table public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'hub')),
  created_at timestamptz not null default now()
);

comment on table public.members is
  'Who may use the app. Insert rows by hand in the SQL editor (see README).';

-- SECURITY DEFINER so policies can call it without recursing into members' RLS.
create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.members m where m.user_id = auth.uid()
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() = 'owner', false)
$$;

create or replace function public.is_hub()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.my_role() = 'hub', false)
$$;

-------------------------------------------------------------------------------
-- Settings (single row)
-------------------------------------------------------------------------------

create table public.settings (
  id smallint primary key default 1 check (id = 1),
  max_late_min integer not null default 60 check (max_late_min between 1 and 1440),
  auto_continue boolean not null default false,
  ntfy_topic text check (ntfy_topic is null or ntfy_topic ~ '^[A-Za-z0-9_-]{1,64}$'),
  updated_at timestamptz not null default now()
);

insert into public.settings (id) values (1) on conflict do nothing;

-------------------------------------------------------------------------------
-- Jobs
-------------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  -- Object key inside the `prints` bucket: <owner uid>/<job id>/<file name>
  storage_path text not null check (char_length(storage_path) between 1 and 512),
  thumb_path text check (thumb_path is null or char_length(thumb_path) <= 512),
  file_size bigint check (file_size is null or file_size >= 0),
  run_at timestamptz not null default now(),
  use_ams boolean not null default false,
  ams_mapping integer[] not null default '{}'
    check (cardinality(ams_mapping) <= 16),
  stage text not null default 'pending' check (stage in (
    'pending', 'uploading', 'printing', 'awaiting_clear',
    'attention', 'done', 'cancelled', 'missed'
  )),
  note text check (note is null or char_length(note) <= 2000),
  est_seconds integer check (est_seconds is null or est_seconds >= 0),
  filament_g numeric(10, 2) check (filament_g is null or filament_g >= 0),
  filament_type text check (filament_type is null or char_length(filament_type) <= 100),
  remote_name text check (remote_name is null or char_length(remote_name) <= 255),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  -- Set by the hub once the stored file has been deleted by the 7-day cleanup.
  file_purged_at timestamptz,
  updated_at timestamptz not null default now()
);

create index jobs_stage_run_at_idx on public.jobs (stage, run_at);
create index jobs_created_at_idx on public.jobs (created_at desc);

-- Column / transition guard. RLS decides *which rows* a role may touch;
-- this decides *what* each role may change in them.
create or replace function public.jobs_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r text := public.my_role();
  hub_cols constant text[] := array[
    'stage', 'note', 'started_at', 'finished_at', 'remote_name', 'file_purged_at', 'updated_at'
  ];
  owner_cols constant text[] := array[
    'name', 'run_at', 'use_ams', 'ams_mapping', 'note', 'stage', 'finished_at', 'updated_at'
  ];
  transition text;
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    return new;
  end if;

  transition := old.stage || '->' || new.stage;

  if r = 'hub' then
    if (to_jsonb(new) - hub_cols) is distinct from (to_jsonb(old) - hub_cols) then
      raise exception 'hub may only change stage, note, started_at, finished_at, remote_name, file_purged_at'
        using errcode = '42501';
    end if;
    if new.stage <> old.stage and transition not in (
      'pending->uploading', 'pending->missed',
      'uploading->printing', 'uploading->attention',
      'printing->awaiting_clear', 'printing->done', 'printing->attention',
      'awaiting_clear->done', 'attention->done'
    ) then
      raise exception 'hub may not move a job %', transition using errcode = '42501';
    end if;
  elsif r = 'owner' then
    if (to_jsonb(new) - owner_cols) is distinct from (to_jsonb(old) - owner_cols) then
      raise exception 'that field cannot be changed' using errcode = '42501';
    end if;
    if new.stage <> old.stage then
      if transition not in ('pending->cancelled', 'attention->cancelled') then
        raise exception 'cannot move a job %', transition using errcode = '42501';
      end if;
    elsif old.stage <> 'pending' and (
      new.name, new.run_at, new.use_ams, new.ams_mapping
    ) is distinct from (
      old.name, old.run_at, old.use_ams, old.ams_mapping
    ) then
      raise exception 'only pending jobs can be edited' using errcode = '42501';
    end if;
    if new.finished_at is distinct from old.finished_at and new.stage = old.stage then
      raise exception 'finished_at is set automatically' using errcode = '42501';
    end if;
  end if;
  -- r is null: superuser / service role (SQL editor, migrations). Allowed.

  if new.stage in ('done', 'cancelled', 'missed') and new.finished_at is null then
    new.finished_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger jobs_guard
before insert or update on public.jobs
for each row execute function public.jobs_guard();

-------------------------------------------------------------------------------
-- Commands (browser -> hub)
-------------------------------------------------------------------------------

create table public.commands (
  id bigint generated always as identity primary key,
  action text not null check (action in ('pause', 'resume', 'stop', 'plate_clear')),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  job_id uuid references public.jobs (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  result text check (result is null or char_length(result) <= 2000)
);

create index commands_pending_idx on public.commands (created_at) where status = 'pending';

create or replace function public.commands_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r text := public.my_role();
  hub_cols constant text[] := array['status', 'handled_at', 'result'];
begin
  if r = 'hub' then
    if (to_jsonb(new) - hub_cols) is distinct from (to_jsonb(old) - hub_cols) then
      raise exception 'hub may only change status, handled_at, result' using errcode = '42501';
    end if;
    if old.status <> 'pending' then
      raise exception 'command already handled' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger commands_guard
before update on public.commands
for each row execute function public.commands_guard();

-------------------------------------------------------------------------------
-- Hub status (single row, written by the hub)
-------------------------------------------------------------------------------

create table public.hub_status (
  id smallint primary key default 1 check (id = 1),
  last_seen timestamptz,
  hub_version text,
  last_error text,
  -- Safety interlock: no job starts while this is false. Starts false so the
  -- owner has to confirm an empty plate before the very first print.
  plate_clear boolean not null default false,
  waiting_reason text,
  active_job_id uuid references public.jobs (id) on delete set null,
  connected boolean not null default false,
  state text,
  progress integer check (progress is null or progress between 0 and 100),
  remaining_min integer,
  nozzle numeric(6, 1),
  bed numeric(6, 1),
  file text,
  updated_at timestamptz not null default now()
);

insert into public.hub_status (id) values (1) on conflict do nothing;

-- last_seen uses the database clock so a hub with a wrong clock can't look
-- online/offline incorrectly.
create or replace function public.hub_status_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.last_seen := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger hub_status_touch
before insert or update on public.hub_status
for each row execute function public.hub_status_touch();

-------------------------------------------------------------------------------
-- Row level security
-------------------------------------------------------------------------------

alter table public.members enable row level security;
alter table public.settings enable row level security;
alter table public.jobs enable row level security;
alter table public.commands enable row level security;
alter table public.hub_status enable row level security;

-- Explicit grants. anon gets nothing at all.
revoke all on public.members, public.settings, public.jobs, public.commands, public.hub_status
  from anon, authenticated;
grant select on public.members to authenticated;
grant select, update on public.settings to authenticated;
grant select, insert, update, delete on public.jobs to authenticated;
grant select, insert, update on public.commands to authenticated;
grant select, insert, update on public.hub_status to authenticated;

revoke execute on function public.my_role(), public.is_owner(), public.is_hub() from anon, public;
grant execute on function public.my_role(), public.is_owner(), public.is_hub() to authenticated;

-- members: each user can see only their own row.
create policy members_self_read on public.members
  for select to authenticated
  using (user_id = (select auth.uid()));

-- settings
create policy settings_read on public.settings
  for select to authenticated
  using ((select public.is_owner()) or (select public.is_hub()));
create policy settings_owner_update on public.settings
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- jobs
create policy jobs_owner_read on public.jobs
  for select to authenticated
  using ((select public.is_owner()) and owner_id = (select auth.uid()));
create policy jobs_hub_read on public.jobs
  for select to authenticated
  using ((select public.is_hub()));
create policy jobs_owner_insert on public.jobs
  for insert to authenticated
  with check (
    (select public.is_owner())
    and owner_id = (select auth.uid())
    and stage = 'pending'
    and started_at is null and finished_at is null
    and remote_name is null and file_purged_at is null
    and storage_path like (select auth.uid())::text || '/%'
    and (thumb_path is null or thumb_path like (select auth.uid())::text || '/%')
  );
create policy jobs_owner_update on public.jobs
  for update to authenticated
  using ((select public.is_owner()) and owner_id = (select auth.uid()))
  with check ((select public.is_owner()) and owner_id = (select auth.uid()));
create policy jobs_hub_update on public.jobs
  for update to authenticated
  using ((select public.is_hub()))
  with check ((select public.is_hub()));
create policy jobs_owner_delete on public.jobs
  for delete to authenticated
  using (
    (select public.is_owner()) and owner_id = (select auth.uid())
    and stage in ('done', 'cancelled', 'missed')
  );

-- commands
create policy commands_read on public.commands
  for select to authenticated
  using ((select public.is_owner()) or (select public.is_hub()));
create policy commands_owner_insert on public.commands
  for insert to authenticated
  with check (
    (select public.is_owner())
    and status = 'pending' and handled_at is null and result is null
    and created_by = (select auth.uid())
  );
create policy commands_hub_update on public.commands
  for update to authenticated
  using ((select public.is_hub()))
  with check ((select public.is_hub()));

-- hub_status
create policy hub_status_read on public.hub_status
  for select to authenticated
  using ((select public.is_owner()) or (select public.is_hub()));
create policy hub_status_hub_insert on public.hub_status
  for insert to authenticated
  with check ((select public.is_hub()));
create policy hub_status_hub_update on public.hub_status
  for update to authenticated
  using ((select public.is_hub()))
  with check ((select public.is_hub()));

-------------------------------------------------------------------------------
-- Storage: one private bucket `prints`
-------------------------------------------------------------------------------

-- VERIFY: 50 MB is the free-plan per-file upload limit at the time of writing.
insert into storage.buckets (id, name, public, file_size_limit)
values ('prints', 'prints', false, 52428800)
on conflict (id) do nothing;

create policy prints_owner_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'prints' and (select public.is_owner())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy prints_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'prints' and (select public.is_owner())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy prints_owner_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'prints' and (select public.is_owner())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy prints_owner_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'prints' and (select public.is_owner())
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
create policy prints_hub_read on storage.objects
  for select to authenticated
  using (bucket_id = 'prints' and (select public.is_hub()));
-- The hub may delete a print file only once its job is finished and 7 days old.
create policy prints_hub_cleanup on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'prints' and (select public.is_hub())
    and exists (
      select 1 from public.jobs j
      where j.storage_path = objects.name
        and j.stage in ('done', 'cancelled', 'missed')
        and j.finished_at < now() - interval '7 days'
    )
  );

-------------------------------------------------------------------------------
-- Realtime
-------------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.jobs, public.hub_status, public.commands, public.settings;
  end if;
end;
$$;

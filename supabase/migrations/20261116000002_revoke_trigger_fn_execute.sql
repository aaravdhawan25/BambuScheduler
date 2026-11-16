-- Trigger functions don't need to be callable over the API (/rest/v1/rpc).
-- Postgres doesn't check EXECUTE when a trigger fires, so triggers keep working.
revoke execute on function public.jobs_guard(), public.commands_guard(), public.hub_status_touch()
  from public, anon, authenticated;

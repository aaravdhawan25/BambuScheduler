-- Run once in the Supabase SQL editor AFTER creating the two users in
-- Authentication -> Users (owner = you, hub = the device account).
-- Replace the emails with yours.

insert into public.members (user_id, role)
select id, 'owner' from auth.users where email = 'you@example.com'
on conflict (user_id) do update set role = excluded.role;

insert into public.members (user_id, role)
select id, 'hub' from auth.users where email = 'hub@example.com'
on conflict (user_id) do update set role = excluded.role;

-- Check:
select u.email, m.role from public.members m join auth.users u on u.id = m.user_id;

-- Together: a shared weekly calendar for two people.
-- Uses the same accounts and shared space as the budget app, so your partner is the other
-- person in that space. Run this once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Needs supabase-setup.sql to have been run first (it makes households, household_members, is_member).

-- ---------- profiles: your name, colour and the hours you count as "free time" ----------
create table if not exists public.couple_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  display_name text not null default '',
  color text not null default '#d9534f',
  day_start smallint not null default 480  check (day_start between 0 and 1439),   -- minutes after midnight
  day_end   smallint not null default 1320 check (day_end between 1 and 1440),
  min_free  smallint not null default 60   check (min_free between 15 and 480),      -- shortest gap worth showing
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now(),
  check (day_end > day_start)
);

-- ---------- events: each person's own calendar; both people can see both ----------
create table if not exists public.couple_events (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists couple_events_space_time on public.couple_events (household_id, starts_at);

alter table public.couple_profiles enable row level security;
alter table public.couple_events enable row level security;

-- true when the signed-in person and u are in the same shared space
create or replace function public.shares_space(u uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from household_members a join household_members b on a.household_id = b.household_id
    where a.user_id = auth.uid() and b.user_id = u);
$$;
revoke all on function public.shares_space(uuid) from public, anon;
grant execute on function public.shares_space(uuid) to authenticated;

drop policy if exists "see own and partner profile" on public.couple_profiles;
create policy "see own and partner profile" on public.couple_profiles for select to authenticated
  using (user_id = auth.uid() or public.shares_space(user_id));
drop policy if exists "make own profile" on public.couple_profiles;
create policy "make own profile" on public.couple_profiles for insert to authenticated
  with check (user_id = auth.uid());
drop policy if exists "change own profile" on public.couple_profiles;
create policy "change own profile" on public.couple_profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- both people read every event in the space; only the owner can add, change or delete theirs
drop policy if exists "members see events" on public.couple_events;
create policy "members see events" on public.couple_events for select to authenticated
  using (public.is_member(household_id));
drop policy if exists "add own events" on public.couple_events;
create policy "add own events" on public.couple_events for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(household_id));
drop policy if exists "change own events" on public.couple_events;
create policy "change own events" on public.couple_events for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.is_member(household_id));
drop policy if exists "delete own events" on public.couple_events;
create policy "delete own events" on public.couple_events for delete to authenticated
  using (user_id = auth.uid());

-- ---------- connect to one partner ----------
-- Like join_household, but refuses a space that already has two other people in it,
-- so a couple stays a couple.
create or replace function public.join_couple(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid; n int;
begin
  select id into h from households where invite_code = upper(trim(code));
  if h is null then raise exception 'No one has that code'; end if;
  select count(*) into n from household_members where household_id = h and user_id <> auth.uid();
  if n >= 2 then raise exception 'That code already belongs to a couple'; end if;
  insert into household_members (household_id, user_id) values (h, auth.uid()) on conflict do nothing;
  delete from household_members where user_id = auth.uid() and household_id <> h;
  return h;
end $$;
revoke all on function public.join_couple(text) from public, anon;
grant execute on function public.join_couple(text) to authenticated;

alter publication supabase_realtime add table public.couple_profiles, public.couple_events;

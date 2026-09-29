-- Budget Tracker: shared space for you and Matthew
-- Private budgets: only the owner can read or change their own.
-- Shared expenses: only members of your shared space can see them.

create table if not exists public.budgets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  invite_code text unique not null default upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.shared_items (
  household_id uuid not null references public.households(id) on delete cascade,
  kind text not null check (kind in ('stx', 'sset', 'sbill')),
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, kind, id)
);

alter table public.budgets enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.shared_items enable row level security;

create or replace function public.is_member(h uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from household_members where household_id = h and user_id = auth.uid());
$$;

create policy "own budget" on public.budgets for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "members read space" on public.households for select to authenticated
  using (public.is_member(id) or created_by = auth.uid());
create policy "create space" on public.households for insert to authenticated
  with check (created_by = auth.uid());
create policy "members update space" on public.households for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));

create policy "see members" on public.household_members for select to authenticated
  using (public.is_member(household_id) or user_id = auth.uid());
create policy "creator joins own space" on public.household_members for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.households h where h.id = household_id and h.created_by = auth.uid()));
create policy "leave space" on public.household_members for delete to authenticated
  using (user_id = auth.uid());

create policy "members use shared items" on public.shared_items for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

create or replace function public.join_household(code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare h uuid;
begin
  select id into h from households where invite_code = upper(trim(code));
  if h is null then raise exception 'No shared space with that code'; end if;
  insert into household_members (household_id, user_id) values (h, auth.uid()) on conflict do nothing;
  delete from household_members where user_id = auth.uid() and household_id <> h;
  return h;
end $$;

revoke all on function public.join_household(text) from public, anon;
grant execute on function public.join_household(text) to authenticated;
revoke all on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;

alter publication supabase_realtime add table public.budgets, public.households, public.shared_items;

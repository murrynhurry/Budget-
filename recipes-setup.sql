-- Recipe Box: recipes, fridge/freezer/pantry, To Buy and coupons.
-- Uses the same accounts and shared space as the budget app, so you and Matthew see the same lists.
-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

create table if not exists public.recipe_docs (
  household_id uuid not null references public.households(id) on delete cascade,
  coll text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (household_id, coll, id)
);

alter table public.recipe_docs enable row level security;

drop policy if exists "members use recipe docs" on public.recipe_docs;
create policy "members use recipe docs" on public.recipe_docs for all to authenticated
  using (public.is_member(household_id)) with check (public.is_member(household_id));

alter publication supabase_realtime add table public.recipe_docs;

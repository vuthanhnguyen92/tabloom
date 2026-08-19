create extension if not exists pgcrypto;

create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  color text not null default '#f56f72' check (color ~ '^#[0-9a-fA-F]{6}$'),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  space_id uuid not null,
  name text not null check (char_length(name) between 1 and 80),
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  constraint collections_space_owner_fk foreign key (space_id, user_id)
    references public.spaces(id, user_id) on delete cascade
);

create table public.links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null,
  url text not null check (url ~ '^https?://'),
  title text not null check (char_length(title) between 1 and 300),
  description text not null default '' check (char_length(description) <= 1000),
  favicon_url text,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint links_collection_owner_fk foreign key (collection_id, user_id)
    references public.collections(id, user_id) on delete cascade
);

create index spaces_owner_position_idx on public.spaces(user_id, position);
create index collections_space_position_idx on public.collections(user_id, space_id, position);
create index links_collection_position_idx on public.links(user_id, collection_id, position);

alter table public.spaces enable row level security;
alter table public.collections enable row level security;
alter table public.links enable row level security;

create policy "owners manage spaces" on public.spaces
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owners manage collections" on public.collections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owners manage links" on public.links
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

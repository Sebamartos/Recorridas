-- Recorridas: tablas, permisos y almacenamiento de archivos.
-- Se pega entero en Supabase → SQL Editor → Run. Se puede volver a correr sin romper nada.

-- ---------- Perfiles de usuario ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  name text,
  role text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);

-- El primer usuario que se registra queda como administrador.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles where role = 'admin') then 'user' else 'admin' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- Campañas, lotes y accesos ----------

create table if not exists public.campaigns (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);

create table if not exists public.lots (
  id text primary key,
  campaign_id text not null references public.campaigns on delete cascade,
  name text not null,
  crop text,
  geometry jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists lots_campaign on public.lots (campaign_id);

create table if not exists public.lot_access (
  user_id uuid references public.profiles on delete cascade,
  lot_id text references public.lots on delete cascade,
  primary key (user_id, lot_id)
);

create or replace function public.can_see_lot(p_lot text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from public.lot_access where user_id = auth.uid() and lot_id = p_lot);
$$;

-- ---------- Notas y archivos ----------

create table if not exists public.notes (
  id text primary key,
  lot_id text not null references public.lots on delete cascade,
  author_id uuid references public.profiles,
  data jsonb not null,
  visit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists notes_lot on public.notes (lot_id);
create index if not exists notes_updated on public.notes (updated_at);

create table if not exists public.media (
  id text primary key,
  note_id text not null references public.notes on delete cascade,
  lot_id text not null references public.lots on delete cascade,
  type text not null check (type in ('photo', 'video', 'audio')),
  mime text,
  path text not null,
  lat double precision,
  lng double precision,
  accuracy double precision,
  loc_source text,
  taken_at timestamptz,
  transcript text,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted boolean not null default false
);
create index if not exists media_note on public.media (note_id);
create index if not exists media_updated on public.media (updated_at);

-- La fecha de modificación la pone el servidor, para que la sincronización
-- no dependa del reloj de cada teléfono.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['campaigns', 'lots', 'notes', 'media'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before insert or update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end;
$$;

-- ---------- Permisos (Row Level Security) ----------

alter table public.profiles enable row level security;
alter table public.campaigns enable row level security;
alter table public.lots enable row level security;
alter table public.lot_access enable row level security;
alter table public.notes enable row level security;
alter table public.media enable row level security;

drop policy if exists "perfiles visibles" on public.profiles;
create policy "perfiles visibles" on public.profiles for select to authenticated using (true);
drop policy if exists "editar mi perfil" on public.profiles;
create policy "editar mi perfil" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (public.is_admin() or (id = auth.uid() and role = (select p.role from public.profiles p where p.id = auth.uid())));

drop policy if exists "ver campañas" on public.campaigns;
create policy "ver campañas" on public.campaigns for select to authenticated
  using (public.is_admin() or exists (select 1 from public.lots l where l.campaign_id = campaigns.id and public.can_see_lot(l.id)));
drop policy if exists "admin campañas" on public.campaigns;
create policy "admin campañas" on public.campaigns for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "ver lotes" on public.lots;
create policy "ver lotes" on public.lots for select to authenticated using (public.can_see_lot(id));
drop policy if exists "admin lotes" on public.lots;
create policy "admin lotes" on public.lots for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "ver accesos" on public.lot_access;
create policy "ver accesos" on public.lot_access for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admin accesos" on public.lot_access;
create policy "admin accesos" on public.lot_access for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "ver notas" on public.notes;
create policy "ver notas" on public.notes for select to authenticated using (public.can_see_lot(lot_id));
drop policy if exists "crear notas" on public.notes;
create policy "crear notas" on public.notes for insert to authenticated
  with check (public.can_see_lot(lot_id) and author_id = auth.uid());
-- Cualquiera con acceso al lote puede actualizar (por ejemplo, tildar un pendiente).
drop policy if exists "editar notas" on public.notes;
create policy "editar notas" on public.notes for update to authenticated
  using (public.can_see_lot(lot_id)) with check (public.can_see_lot(lot_id));

drop policy if exists "ver archivos" on public.media;
create policy "ver archivos" on public.media for select to authenticated using (public.can_see_lot(lot_id));
drop policy if exists "crear archivos" on public.media;
create policy "crear archivos" on public.media for insert to authenticated with check (public.can_see_lot(lot_id));
drop policy if exists "editar archivos" on public.media;
create policy "editar archivos" on public.media for update to authenticated
  using (public.can_see_lot(lot_id)) with check (public.can_see_lot(lot_id));

-- Al darle acceso a un lote, se "tocan" sus datos para que el usuario los baje
-- en su próxima sincronización.
create or replace function public.touch_lot_data()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.lots set updated_at = now() where id = new.lot_id;
  update public.campaigns set updated_at = now() where id = (select campaign_id from public.lots where id = new.lot_id);
  update public.notes set updated_at = now() where lot_id = new.lot_id;
  update public.media set updated_at = now() where lot_id = new.lot_id;
  return new;
end;
$$;

drop trigger if exists touch_on_access on public.lot_access;
create trigger touch_on_access after insert on public.lot_access
  for each row execute function public.touch_lot_data();

-- ---------- Almacenamiento de fotos, videos y audios ----------

insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- Los archivos se guardan como <lote>/<nota>/<archivo>.
drop policy if exists "media ver" on storage.objects;
create policy "media ver" on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.can_see_lot((storage.foldername(name))[1]));
drop policy if exists "media subir" on storage.objects;
create policy "media subir" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.can_see_lot((storage.foldername(name))[1]));
drop policy if exists "media actualizar" on storage.objects;
create policy "media actualizar" on storage.objects for update to authenticated
  using (bucket_id = 'media' and public.can_see_lot((storage.foldername(name))[1]));

-- ---------- Acceso de la app a las tablas (lo filtran las políticas de arriba) ----------

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.campaigns, public.lots, public.lot_access, public.notes, public.media to authenticated;
revoke all on public.profiles, public.campaigns, public.lots, public.lot_access, public.notes, public.media from anon;

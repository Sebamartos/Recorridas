-- Avisos (notificaciones) de notas nuevas. Se puede correr más de una vez.
-- Estas tablas solo las usa la función "notify" desde el servidor:
-- la app no puede leerlas directamente.

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

create table if not exists public.push_config (
  id int primary key,
  public_key text not null,
  private_jwk jsonb not null
);

create table if not exists public.push_sent (
  note_id text primary key,
  sent_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
alter table public.push_config enable row level security;
alter table public.push_sent enable row level security;
revoke all on public.push_subscriptions, public.push_config, public.push_sent from anon, authenticated;

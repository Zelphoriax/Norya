-- Schéma de base de Norya.
--
-- Reconstitué depuis index.html : chaque table, chaque colonne et chaque
-- relation vient d'un appel réel de l'objet `store`, et les types viennent
-- des données de `demoStore`. Le projet Supabase actuel ne contenait qu'une
-- table `profiles` vide — le changement de compte du 14/09/2026 a déplacé le
-- pointeur sans emporter le schéma.
--
-- Entièrement idempotente : `if not exists` partout, pour pouvoir être
-- rejouée sans casser ce qui existe déjà.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- rôle admin
-- `security definer` et non une sous-requête directe : une politique sur
-- profiles qui interrogerait profiles provoquerait une récursion infinie.
create or replace function est_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- ----------------------------------------------------------------- profiles
create table if not exists profiles (
  id                       uuid primary key references auth.users(id) on delete cascade,
  email                    text,
  full_name                text,
  role                     text    not null default 'commercial',
  commission_rate          integer not null default 40,
  recurring_commission_rate integer not null default 0,
  current_city             text,
  current_city_public      boolean not null default true,
  is_active                boolean not null default true,
  avatar_url               text,
  avatar_public            boolean not null default false,
  invisible                boolean not null default false,
  last_seen_at             timestamptz,
  chat_read_at             timestamptz,
  created_at               timestamptz not null default now()
);

-- La table existait déjà, vide et de contenu inconnu : on complète colonne
-- par colonne plutôt que de supposer sa forme.
alter table profiles
  add column if not exists email                     text,
  add column if not exists full_name                 text,
  add column if not exists role                      text    not null default 'commercial',
  add column if not exists commission_rate           integer not null default 40,
  add column if not exists recurring_commission_rate integer not null default 0,
  add column if not exists current_city              text,
  add column if not exists current_city_public       boolean not null default true,
  add column if not exists is_active                 boolean not null default true,
  add column if not exists avatar_url                text,
  add column if not exists avatar_public             boolean not null default false,
  add column if not exists invisible                 boolean not null default false,
  add column if not exists last_seen_at              timestamptz,
  add column if not exists chat_read_at              timestamptz,
  add column if not exists created_at                timestamptz not null default now();

do $$ begin
  alter table profiles add constraint profiles_role_valide
    check (role in ('admin','commercial'));
exception when duplicate_object then null; end $$;

-- Un compte créé dans auth.users obtient son profil sans intervention.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------- prospects
create table if not exists prospects (
  id                       uuid primary key default gen_random_uuid(),
  company_name             text not null,
  category                 text,
  city                     text,
  address                  text,
  phone                    text,
  email                    text,
  contact_name             text,
  website_quality          text,
  website_url              text,
  delivered_url            text,
  google_rating            numeric(2,1),
  status                   text not null default 'a_contacter',
  assigned_to              uuid references profiles(id) on delete set null,
  created_by               uuid references profiles(id) on delete set null,
  last_contact_at          timestamptz,
  closed_at                timestamptz,
  paid_at                  timestamptz,
  sale_amount              numeric(10,2) not null default 0,
  recurring_amount         numeric(10,2) not null default 0,
  billing_day              integer,
  commission_rate_snapshot integer,
  recurring_rate_snapshot  integer,
  notes                    text,
  created_at               timestamptz not null default now()
);

do $$ begin
  alter table prospects add constraint prospects_status_valide
    check (status in ('a_contacter','conclu','refuse'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table prospects add constraint prospects_site_valide
    check (website_quality is null or website_quality in ('aucun','mauvais','correct'));
exception when duplicate_object then null; end $$;

-- Limité à 28 pour que la date existe tous les mois, février compris.
do $$ begin
  alter table prospects add constraint prospects_billing_day_valide
    check (billing_day is null or (billing_day between 1 and 28));
exception when duplicate_object then null; end $$;

create index if not exists prospects_assigned_idx on prospects(assigned_to);
create index if not exists prospects_status_idx   on prospects(status);
create index if not exists prospects_created_idx  on prospects(created_at desc);

-- --------------------------------------------------------------- activities
-- Le type reste libre : c'est un journal, et le contraindre ferait échouer
-- l'écriture d'une trace nouvelle plutôt que de la consigner.
create table if not exists activities (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid references prospects(id) on delete cascade,
  user_id     uuid references profiles(id) on delete set null,
  type        text not null,
  content     text,
  created_at  timestamptz not null default now()
);

create index if not exists activities_prospect_idx on activities(prospect_id);
create index if not exists activities_created_idx  on activities(created_at desc);

-- -------------------------------------------------------------------- goals
create table if not exists goals (
  id             uuid primary key default gen_random_uuid(),
  month          date    not null,
  target_sales   integer not null default 0,
  target_revenue numeric(10,2) not null default 0,
  note           text,
  created_by     uuid references profiles(id) on delete cascade,
  created_at     timestamptz not null default now()
);

-- store.setGoal fait upsert(onConflict: "created_by,month") : sans cet index
-- unique, l'upsert échoue.
create unique index if not exists goals_auteur_mois_unique on goals(created_by, month);

-- ------------------------------------------------------------- applications
-- Dossiers d'inscription déposés depuis l'écran public. Le mot de passe n'y
-- est jamais stocké : seul le fait qu'il ait été saisi, et sa robustesse.
create table if not exists applications (
  id                uuid primary key default gen_random_uuid(),
  nom               text,
  prenom            text,
  email             text,
  telephone         text,
  adresse           text,
  siret             text,
  rsac              text,
  justificatif_name text,
  rib_name          text,
  password_set      boolean not null default false,
  password_score    integer,
  status            text    not null default 'en_attente',
  reviewed_at       timestamptz,
  reviewed_by       uuid references profiles(id) on delete set null,
  note              text,
  profile_id        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

do $$ begin
  alter table applications add constraint applications_status_valide
    check (status in ('en_attente','accepte','refuse'));
exception when duplicate_object then null; end $$;

-- -------------------------------------------------------- activity_sessions
create table if not exists activity_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references profiles(id) on delete cascade,
  user_agent   text,
  started_at   timestamptz not null default now(),
  last_ping_at timestamptz not null default now()
);

create index if not exists sessions_started_idx on activity_sessions(started_at desc);

-- ----------------------------------------------------------------- messages
create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references profiles(id) on delete set null,
  prospect_id     uuid references prospects(id) on delete set null,
  body            text not null default '',
  attachment_path text,
  attachment_name text,
  attachment_size bigint,
  attachment_type text,
  created_at      timestamptz not null default now()
);

create index if not exists messages_created_idx on messages(created_at);

create table if not exists message_reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

-- --------------------------------------------------------------- présence
-- store.pingSession appelle ce RPC à chaque battement.
create or replace function touch_presence()
returns void
language sql
security definer
set search_path = public
as $$
  update profiles set last_seen_at = now() where id = auth.uid();
$$;

-- ------------------------------------------------------- commission_summary
-- store.commissions() lit cette vue. Une commission n'est due que sur une
-- vente encaissée : sans paid_at, rien n'est acquis.
create or replace view commission_summary as
select
  p.assigned_to                                            as user_id,
  pr.full_name,
  date_trunc('month', p.closed_at)::date                   as month,
  count(*)                                                 as sales,
  sum(p.sale_amount)                                       as revenue,
  sum(p.sale_amount * coalesce(p.commission_rate_snapshot, 40) / 100.0) as commission,
  count(*) filter (where p.paid_at is null)                as awaiting_payment
from prospects p
join profiles pr on pr.id = p.assigned_to
where p.status = 'conclu' and p.assigned_to is not null
group by p.assigned_to, pr.full_name, date_trunc('month', p.closed_at);

-- ------------------------------------------------------------------ RLS
alter table profiles          enable row level security;
alter table prospects         enable row level security;
alter table activities        enable row level security;
alter table goals             enable row level security;
alter table applications      enable row level security;
alter table activity_sessions enable row level security;
alter table messages          enable row level security;
alter table message_reactions enable row level security;

-- L'équipe se voit ; chacun ne modifie que sa propre fiche, sauf un admin.
drop policy if exists profiles_lecture on profiles;
create policy profiles_lecture on profiles for select
  using (auth.uid() is not null);

drop policy if exists profiles_maj on profiles;
create policy profiles_maj on profiles for update
  using (id = auth.uid() or est_admin());

drop policy if exists profiles_creation on profiles;
create policy profiles_creation on profiles for insert
  with check (est_admin());

-- Les prospects appartiennent à l'agence : tout le monde les voit.
-- L'admin crée et supprime ; un commercial modifie ce qui lui est attribué.
drop policy if exists prospects_lecture on prospects;
create policy prospects_lecture on prospects for select
  using (auth.uid() is not null);

drop policy if exists prospects_creation on prospects;
create policy prospects_creation on prospects for insert
  with check (est_admin());

drop policy if exists prospects_maj on prospects;
create policy prospects_maj on prospects for update
  using (assigned_to = auth.uid() or est_admin());

drop policy if exists prospects_suppression on prospects;
create policy prospects_suppression on prospects for delete
  using (est_admin());

drop policy if exists activities_lecture on activities;
create policy activities_lecture on activities for select
  using (auth.uid() is not null);

drop policy if exists activities_creation on activities;
create policy activities_creation on activities for insert
  with check (user_id = auth.uid());

drop policy if exists goals_lecture on goals;
create policy goals_lecture on goals for select
  using (auth.uid() is not null);

drop policy if exists goals_ecriture on goals;
create policy goals_ecriture on goals for all
  using (created_by = auth.uid() or est_admin())
  with check (created_by = auth.uid() or est_admin());

-- Un dossier se dépose sans compte : c'est l'écran public d'inscription.
-- Seul un admin peut ensuite le lire ou le trancher.
drop policy if exists applications_depot on applications;
create policy applications_depot on applications for insert
  with check (true);

drop policy if exists applications_lecture on applications;
create policy applications_lecture on applications for select
  using (est_admin());

drop policy if exists applications_maj on applications;
create policy applications_maj on applications for update
  using (est_admin());

drop policy if exists applications_suppression on applications;
create policy applications_suppression on applications for delete
  using (est_admin());

drop policy if exists sessions_lecture on activity_sessions;
create policy sessions_lecture on activity_sessions for select
  using (user_id = auth.uid() or est_admin());

drop policy if exists sessions_creation on activity_sessions;
create policy sessions_creation on activity_sessions for insert
  with check (user_id = auth.uid());

drop policy if exists sessions_maj on activity_sessions;
create policy sessions_maj on activity_sessions for update
  using (user_id = auth.uid());

drop policy if exists messages_lecture on messages;
create policy messages_lecture on messages for select
  using (auth.uid() is not null);

drop policy if exists messages_envoi on messages;
create policy messages_envoi on messages for insert
  with check (user_id = auth.uid());

-- On efface son propre message ; un admin peut modérer.
drop policy if exists messages_suppression on messages;
create policy messages_suppression on messages for delete
  using (user_id = auth.uid() or est_admin());

drop policy if exists reactions_lecture on message_reactions;
create policy reactions_lecture on message_reactions for select
  using (auth.uid() is not null);

drop policy if exists reactions_ecriture on message_reactions;
create policy reactions_ecriture on message_reactions for insert
  with check (user_id = auth.uid());

drop policy if exists reactions_retrait on message_reactions;
create policy reactions_retrait on message_reactions for delete
  using (user_id = auth.uid());

-- ------------------------------------------------------------- temps réel
-- store.onNewMessage écoute ces deux tables.
do $$ begin
  alter publication supabase_realtime add table messages;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table message_reactions;
exception when duplicate_object then null; end $$;

-- --------------------------------------------------------------- stockage
-- Bucket privé : store.fileUrl ne sert que des URL signées, valables 5 min.
insert into storage.buckets (id, name, public)
values ('chat', 'chat', false)
on conflict (id) do nothing;

drop policy if exists chat_lecture on storage.objects;
create policy chat_lecture on storage.objects for select
  using (bucket_id = 'chat' and auth.uid() is not null);

-- Le chemin déposé est `<user_id>/<horodatage>-<nom>` : on impose que le
-- premier segment soit bien celui de l'émetteur.
drop policy if exists chat_depot on storage.objects;
create policy chat_depot on storage.objects for insert
  with check (
    bucket_id = 'chat'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Systeme de paiement Norya : colonnes et tables.
-- Ecrite pour etre rejouable : elle s'applique sur une base qui la porte
-- deja sans echouer, parce qu'elle sera poussee sur le projet heberge et
-- non sur une base locale jetable.

-- ---------------------------------------------------------------
-- Colonnes ajoutees aux tables existantes
-- ---------------------------------------------------------------
alter table profiles
  add column if not exists stripe_account_id      text,
  add column if not exists stripe_payouts_enabled boolean not null default false;

alter table prospects
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists payment_status         text not null default 'aucun';

-- add constraint n'est pas idempotent : on retire avant d'ajouter.
alter table prospects
  drop constraint if exists prospects_payment_status_valide;
alter table prospects
  add constraint prospects_payment_status_valide
  check (payment_status in ('aucun','en_cours','regle','echec','litige'));

-- ---------------------------------------------------------------
-- Un encaissement : le site, ou un mois de maintenance
-- ---------------------------------------------------------------
create table if not exists payments (
  id                       uuid primary key default gen_random_uuid(),
  prospect_id              uuid not null references prospects(id) on delete cascade,
  commercial_id            uuid references profiles(id),
  type                     text not null check (type in ('site','maintenance')),
  amount_cents             integer not null check (amount_cents > 0),
  stripe_invoice_id        text unique,
  stripe_payment_intent_id text,
  status                   text not null
                             check (status in ('en_cours','paye','echec','litige')),
  paid_at                  timestamptz,
  created_at               timestamptz not null default now()
);

create index if not exists payments_prospect_idx   on payments(prospect_id);
create index if not exists payments_commercial_idx on payments(commercial_id);
create index if not exists payments_paid_at_idx    on payments(paid_at);

-- ---------------------------------------------------------------
-- Le versement des 320 EUR vers le compte Express du commercial
-- ---------------------------------------------------------------
create table if not exists commission_transfers (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments(id) on delete cascade,
  commercial_id      uuid not null references profiles(id),
  amount_cents       integer not null check (amount_cents > 0),
  stripe_transfer_id text unique,
  status             text not null
                       check (status in ('en_attente_onboarding','verse','echec')),
  created_at         timestamptz not null default now()
);

-- Deuxieme ceinture derriere l'idempotence par stripe_events : meme si un
-- evenement etait traite deux fois, la base refuserait la seconde commission.
create unique index if not exists commission_transfers_payment_unique
  on commission_transfers(payment_id);

create index if not exists commission_transfers_attente_idx
  on commission_transfers(commercial_id)
  where status = 'en_attente_onboarding';

-- ---------------------------------------------------------------
-- Idempotence : Stripe rejoue ses evenements
-- ---------------------------------------------------------------
create table if not exists stripe_events (
  id           text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);

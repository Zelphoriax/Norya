-- RLS des tables de paiement.
-- Personne n'ecrit depuis le navigateur : seules les Edge Functions
-- ecrivent, en service_role, qui contourne RLS par construction.
-- On ne declare donc que des politiques de lecture.

alter table payments             enable row level security;
alter table commission_transfers enable row level security;
alter table stripe_events        enable row level security;

-- create policy n'est pas idempotent : on retire avant de creer.
drop policy if exists payments_lecture  on payments;
drop policy if exists transfers_lecture on commission_transfers;

-- Un commercial lit ses propres encaissements ; un administrateur lit tout.
create policy payments_lecture on payments for select
  using (
    commercial_id = auth.uid()
    or exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

create policy transfers_lecture on commission_transfers for select
  using (
    commercial_id = auth.uid()
    or exists (
      select 1 from profiles
      where id = auth.uid() and role = 'admin'
    )
  );

-- stripe_events ne recoit aucune politique : RLS active sans politique de
-- lecture rend la table invisible a tout client. C'est voulu, elle ne
-- regarde que le webhook.

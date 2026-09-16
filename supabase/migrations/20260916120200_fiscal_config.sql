-- Regle fiscale et compteur de chiffre d'affaires.
--
-- La base du CA en micro-entreprise reste a confirmer aupres d'un comptable :
-- elle n'est donc ecrite nulle part en dur. Changer d'interpretation est un
-- UPDATE sur cette table, pas un redeploiement.

create table if not exists fiscal_config (
  annee                 integer primary key,
  ca_base               text    not null default 'brut_encaisse'
                          check (ca_base in ('brut_encaisse','net_commission')),
  seuil_franchise_cents integer not null default 3750000,   -- 37 500 EUR
  seuil_tolerance_cents integer not null default 4125000,   -- 41 250 EUR
  mention_facture       text    not null
                          default 'TVA non applicable, art. 293 B du CGI',
  regle_confirmee       boolean not null default false
);

-- Une ligne par annee civile : les seuils bougent d'une loi de finances a
-- l'autre, et un exercice clos ne doit pas etre recalcule avec les seuils
-- de l'exercice suivant.
insert into fiscal_config (annee) values (2026)
  on conflict (annee) do nothing;

alter table fiscal_config enable row level security;

drop policy if exists fiscal_lecture on fiscal_config;
create policy fiscal_lecture on fiscal_config for select
  using (auth.uid() is not null);

-- CA encaisse par annee civile, selon la base en vigueur cette annee-la.
-- En base 'net_commission' on retranche la commission reellement versee,
-- jamais une constante : le montant vit dans commission_transfers.
--
-- Le left join part de fiscal_config et non de payments, pour qu'une annee
-- sans aucun encaissement renvoie une ligne a zero plutot qu'aucune ligne.
-- Sans cela la jauge cote interface n'afficherait rien au lieu d'afficher 0.
create or replace view ca_annuel as
select
  f.annee,
  coalesce(sum(
    case
      when f.ca_base = 'net_commission'
        then p.amount_cents - coalesce(ct.amount_cents, 0)
      else p.amount_cents
    end
  ), 0)::bigint          as ca_cents,
  f.seuil_franchise_cents,
  f.seuil_tolerance_cents,
  f.ca_base,
  f.regle_confirmee
from fiscal_config f
left join payments p
  on p.status = 'paye'
 and extract(year from p.paid_at)::int = f.annee
left join commission_transfers ct
  on ct.payment_id = p.id
 and ct.status = 'verse'
group by f.annee, f.seuil_franchise_cents, f.seuil_tolerance_cents,
         f.ca_base, f.regle_confirmee;

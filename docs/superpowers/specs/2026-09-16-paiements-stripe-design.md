# Norya — Système de paiement (design)

Date : 2026-09-16
Statut : approuvé (approche A), en attente de relecture
Périmètre : encaissement client final, versement des commissions, suivi du CA et des seuils de TVA

---

## 1. Contexte

Norya est un fichier `index.html` unique en JavaScript vanilla, adossé à Supabase
(projet `olirdsbyvxjlysdylrmr`). Aucun paiement n'est déclenché aujourd'hui :
`billingForm()` enregistre seulement le jour de prélèvement convenu, et `paid_at`
est basculé à la main par un commercial dans une modale qui dit
« Ne confirmez une vente que si le client a effectué le paiement ».

Ce design remplace cette confiance déclarative par une confirmation bancaire.

### Structure juridique

Entrepreneur individuel, régime micro-entreprise.
SIRET `98421507900018` · APE `6201Z` · 2 Square des Grisons, 35200 Rennes.
L'activité « création et maintenance de sites internet » a été ajoutée au RNE
le 16/09/2026 : l'objet couvre explicitement les deux lignes facturées.

Conséquence directe : **franchise en base de TVA**. Les prix Stripe sont créés
sans taxe, Stripe Tax reste désactivé, et les factures portent la mention
« TVA non applicable, art. 293 B du CGI ».

### Barème (inchangé, déjà dans le code)

| Poste | Montant | Constante |
|---|---|---|
| Site internet, à la signature | 800 € | `SITE_PRICE` |
| Maintenance mensuelle | 49 € | `MAINTENANCE_FEE` |
| Commission commerciale | 320 € (40 %) | `COMMERCIAL_COMMISSION` |
| Part Nova | 480 € | `NOVA_SHARE` |
| URSSAF (21,2 % du brut) | 169,60 € | `URSSAF` |

La maintenance ne génère aucune commission (`recurring_commission_rate: 0`).

---

## 2. Décisions actées

1. **Un seul geste de paiement, en rendez-vous.** Le commercial ouvre Norya sur
   son téléphone, le client paie une fois — les 49 €/mois sont armés dans la
   foulée, sans recontact.
2. **Carte et prélèvement SEPA au choix du client.** La carte confirme en
   quelques secondes ; le SEPA coûte ~0,35 € au lieu de ~12,25 € mais met environ
   cinq jours ouvrés à se confirmer.
3. **Stripe Connect Express** pour verser les commissions automatiquement.
4. **Supabase Edge Functions** pour le code serveur, **Cloudflare Pages** pour
   servir `index.html`.
5. **Le webhook fait foi.** Le navigateur ne décide jamais qu'une vente est payée.
6. **Aucun remboursement commercial** (politique). Les oppositions carte et les
   impayés SEPA restent possibles et sont tracés, pas combattus.

---

## 3. Architecture

```
Téléphone du commercial
  └── index.html (Cloudflare Pages, https)
        │  JWT Supabase
        ├──> POST /functions/v1/create-checkout ──> Stripe Checkout Session
        └──> POST /functions/v1/connect-onboarding ──> Stripe AccountLink
                                                            │
Stripe ── événements signés ──> POST /functions/v1/stripe-webhook
                                      │ service_role
                                      └──> Postgres (paid_at, payments,
                                           commission_transfers, ca_annuel)
```

Trois fonctions, pas une de plus. Le navigateur ne détient aucun secret : il
reçoit une URL de Checkout et y redirige, rien d'autre.

### Pourquoi Supabase plutôt que Cloudflare pour le serveur

Les Edge Functions vérifient nativement le JWT du commercial et écrivent en base
avec la `service_role` sans qu'aucun secret supplémentaire ne transite. Sur
Cloudflare Pages Functions il faudrait poser la service-role key dans
l'environnement Cloudflare et réimplémenter la vérification du JWT à la main.

---

## 4. Modèle Stripe

### Objets à créer (mode test d'abord, puis live)

| Produit | Prix | Type | Taxe |
|---|---|---|---|
| Site internet | 800,00 € | `one_time` | aucune |
| Maintenance Norya | 49,00 € | `recurring`, `month` | aucune |

`tax_behavior` laissé non spécifié, Stripe Tax désactivé. Les identifiants de
prix vivent dans les secrets de l'Edge Function, jamais dans `index.html`.

### La session de Checkout

```js
mode: "subscription",
line_items: [
  { price: PRICE_MAINTENANCE, quantity: 1 },  // 49 €/mois
  { price: PRICE_SITE,        quantity: 1 }   // 800 €, première facture
],
payment_method_types: ["card", "sepa_debit"],
subscription_data: {
  billing_cycle_anchor: <timestamp du prochain billing_day>,
  proration_behavior: "none",
  metadata: { prospect_id, commercial_id }
},
customer_email: prospect.email,
metadata: { prospect_id, commercial_id },
success_url, cancel_url  // domaine Cloudflare Pages
```

En mode `subscription`, un prix ponctuel placé dans `line_items` n'apparaît que
sur la **première facture** : c'est ce qui permet d'encaisser les 800 € et
d'armer le récurrent en une seule opération. `proration_behavior: "none"` évite
de facturer au client un mois partiel jusqu'à l'ancre.

### Le jour de prélèvement devient une entrée, pas un réglage a posteriori

Aujourd'hui `billingForm()` se règle après coup. Il doit désormais être choisi
**avant** l'ouverture du Checkout, puisqu'il détermine `billing_cycle_anchor`.
La contrainte existante (1 à 28, pour que la date existe tous les mois) est
conservée telle quelle.

### Les commissions

Transferts **séparés** de l'encaissement, déclenchés à `invoice.paid` et non à
la création de la session : immédiat en carte, après compensation en SEPA. Un
transfert de 320 € vers le compte Express du commercial, uniquement sur la
première facture. Aucun transfert sur les factures de maintenance.

Si le commercial n'a pas terminé sa vérification Stripe, le transfert est mis en
file (`commission_transfers.status = 'en_attente_onboarding'`) et rejoué à
`account.updated` quand `payouts_enabled` passe à vrai. La vente n'est jamais
bloquée pour autant.

---

## 5. Schéma Supabase

### Colonnes ajoutées

```sql
alter table profiles
  add column stripe_account_id     text,
  add column stripe_payouts_enabled boolean not null default false;

alter table prospects
  add column stripe_customer_id     text,
  add column stripe_subscription_id text,
  add column payment_status         text not null default 'aucun';
  -- aucun | en_cours | regle | echec | litige
```

`paid_at` est conservé : il reste la source de vérité du « conclu · encaissé »
dans l'interface, mais il n'est plus écrit que par le webhook.

### Tables nouvelles

```sql
create table payments (
  id                 uuid primary key default gen_random_uuid(),
  prospect_id        uuid not null references prospects(id),
  commercial_id      uuid references profiles(id),
  type               text not null,          -- site | maintenance
  amount_cents       integer not null,
  stripe_invoice_id  text unique,
  stripe_payment_intent_id text,
  status             text not null,          -- en_cours | paye | echec | litige
  paid_at            timestamptz,
  created_at         timestamptz not null default now()
);

create table commission_transfers (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments(id),
  commercial_id      uuid not null references profiles(id),
  amount_cents       integer not null,
  stripe_transfer_id text unique,
  status             text not null,          -- en_attente_onboarding | verse | echec
  created_at         timestamptz not null default now()
);

create table stripe_events (
  id           text primary key,             -- l'id d'événement Stripe
  type         text not null,
  processed_at timestamptz not null default now()
);
```

`stripe_events` porte l'idempotence : Stripe rejoue ses événements, et un rejeu
ne doit jamais verser deux fois 320 €. Le webhook insère l'id en premier ; si
l'insertion viole la clé primaire, il répond 200 sans rien faire.

### RLS

Un commercial lit ses propres `payments` et `commission_transfers` (via
`commercial_id = auth.uid()`), un administrateur lit tout. Personne n'écrit :
seules les Edge Functions écrivent, en `service_role`.

---

## 6. Les trois Edge Functions

### `create-checkout` — JWT requis

Entrée `{ prospect_id, billing_day }`. Vérifie que l'appelant est bien
l'assigné de la fiche ou un administrateur, que la fiche n'est pas déjà réglée,
et que `billing_day` est dans 1..28. Crée ou réutilise le Customer Stripe, crée
la session, renvoie `{ url }`.

Toute la validation est refaite côté serveur. Ce que le navigateur envoie n'est
qu'une intention.

### `connect-onboarding` — JWT requis

Crée le compte Express du commercial s'il n'en a pas, stocke
`stripe_account_id`, renvoie une `AccountLink` d'onboarding. Idempotent :
rappelé, il renvoie un nouveau lien vers le même compte.

### `stripe-webhook` — pas de JWT, signature Stripe obligatoire

`verify_jwt` désactivé (Stripe n'a pas de JWT Supabase), signature vérifiée avec
`STRIPE_WEBHOOK_SECRET`. Une requête sans signature valide est rejetée en 400.

| Événement | Effet |
|---|---|
| `checkout.session.completed` | Rattache `stripe_customer_id` et `stripe_subscription_id`. N'écrit pas `paid_at` : en SEPA le paiement n'est pas encore acquis. |
| `invoice.paid` | Crée le `payment`. Si première facture : écrit `paid_at`, `payment_status = 'regle'`, puis déclenche le transfert de 320 €. Sinon : enregistre la maintenance. |
| `invoice.payment_failed` | `payment_status = 'echec'`, la fiche le montre. |
| `charge.dispute.created` | `payment_status = 'litige'`. |
| `account.updated` | Met à jour `stripe_payouts_enabled` et rejoue les transferts en attente. |

---

## 7. Règle fiscale : paramétrée, pas codée en dur

En micro-entreprise le CA déclaré est l'encaissement brut, et les commissions
versées ne sont pas déductibles. Sous cette lecture, chaque vente pèse 800 € au
compteur alors que 480 € seulement sont conservés — le seuil de franchise de
37 500 € tombe vers la 47ᵉ vente, la tolérance de 41 250 € vers la 52ᵉ.

C'est la lecture retenue par défaut parce qu'elle est la plus prudente, et parce
que le code applique déjà la même logique à l'URSSAF (`169,60 € = 21,2 % de 800`,
non de 480). **Elle reste à confirmer** auprès d'un comptable ou de l'URSSAF, et
n'est donc écrite nulle part en dur :

```sql
create table fiscal_config (
  annee                 integer primary key,
  ca_base               text    not null default 'brut_encaisse',
                                -- brut_encaisse | net_commission
  seuil_franchise_cents integer not null default 3750000,   -- 37 500 €
  seuil_tolerance_cents integer not null default 4125000,   -- 41 250 €
  mention_facture       text    not null
    default 'TVA non applicable, art. 293 B du CGI',
  regle_confirmee       boolean not null default false
);

insert into fiscal_config (annee) values (2026);
```

Une ligne par année civile : les seuils et la règle bougent d'une loi de
finances à l'autre, et un exercice clos ne doit pas être recalculé
rétroactivement avec les seuils de l'exercice suivant. La vue lit la ligne de
l'année de l'encaissement, pas celle de l'année en cours.

Changer d'interprétation est un `UPDATE`, pas un redéploiement. Tant que
`regle_confirmee` est faux, l'interface affiche la règle en vigueur et le fait
qu'elle est provisoire — l'administrateur ne doit jamais croire qu'un chiffre
est arbitré alors qu'il ne l'est pas.

Les seuils sont eux aussi en base : ils bougent d'une loi de finances à l'autre.

### Le compteur

Une vue `ca_annuel` somme les `payments` payés de l'année civile selon
`ca_base`, et l'espace administrateur affiche une jauge vers le seuil. L'alerte
se déclenche à 80 % — assez tôt pour arbitrer, pas assez tard pour subir.

---

## 8. Interface Norya

**Fiche prospect.** Un bouton « Encaisser » ouvre une modale qui demande le jour
de prélèvement, affiche ce que le client va payer (800 € aujourd'hui, puis 49 €
le N de chaque mois), et ouvre le Checkout. Le bouton reste cliquable en toute
circonstance : s'il manque un e-mail ou si la fiche est déjà réglée, c'est la
modale qui l'explique. Un bouton grisé se lit comme une panne.

**Pastilles de statut.** `pillLabel()` gagne les états que le SEPA rend
nécessaires : « en cours de compensation », « échec de paiement », « litige ».
Sans eux, une vente payée par SEPA serait indiscernable d'une vente impayée
pendant cinq jours.

**Inscription, étape 4/4.** L'upload de RIB disparaît : avec Connect, c'est
Stripe qui collecte l'IBAN et vérifie l'identité. À la place, « Connecter mon
compte de paiement » ouvre l'onboarding Express. L'étape reste franchissable
sans l'avoir fait — on ne bloque pas une inscription sur une vérification
bancaire.

**Espace commercial.** Un bandeau d'état Stripe quand la vérification n'est pas
finie, rédigé comme un état et à la deuxième personne (« Votre compte de
paiement est en cours de vérification ; vos commissions seront versées dès
qu'elle sera terminée »). Jamais comme une erreur.

**Espace administrateur.** La carte « CA de l'année » avec la jauge de seuil, et
le journal des transferts de commission.

---

## 9. Sécurité

- Aucune clé secrète Stripe dans `index.html`. Le Checkout par redirection ne
  demande même pas de clé publique.
- Secrets posés par `supabase secrets set` : `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `PRICE_SITE`, `PRICE_MAINTENANCE`.
- Signature du webhook obligatoire.
- Idempotence par `stripe_events`.
- Les montants ne sont jamais lus depuis la requête du navigateur : les 800 € et
  les 49 € viennent des `Price` Stripe, les 320 € d'une constante serveur.
- **`DEMO = true` ne doit jamais atteindre une Edge Function.** Le mode
  démonstration fabrique des ventes fictives ; s'il pouvait ouvrir un Checkout,
  un profil d'essai déclencherait de vrais paiements. Garde explicite en tête de
  chaque appel, et test de non-régression dédié.

---

## 10. Tests

En mode test Stripe de bout en bout, avant toute bascule en live :

- Carte `4242…` → `paid_at` écrit, transfert de 320 € émis.
- IBAN de test SEPA → la fiche reste « en cours de compensation », puis bascule.
- IBAN d'échec → `payment_status = 'echec'`, aucun transfert.
- Webhook rejoué deux fois → **une seule** commission versée.
- Vente par un commercial non onboardé → transfert en file, versé à
  `account.updated`.
- Ancre de facturation : abonnement facturé au jour choisi, sans prorata.
- `DEMO = true` → aucun appel réseau vers une Edge Function.

---

## 11. Ordre de déploiement

1. Déployer `index.html` sur Cloudflare Pages (l'URL conditionne les URLs de
   retour Stripe).
2. Stripe **mode test** : créer les deux produits et leurs prix.
3. Migrations Supabase (colonnes, tables, RLS, vue, `fiscal_config`).
4. Déployer les trois Edge Functions, poser les secrets, enregistrer le webhook.
5. Brancher l'interface.
6. Dérouler la campagne de tests ci-dessus.
7. Activer Connect, repasser les objets en live, basculer les clés, `DEMO = false`.

Rien n'est irréversible avant l'étape 7, et l'étape 7 suppose un IBAN au nom de
la structure : sans compte bancaire professionnel, Stripe accepte d'encaisser
mais retient les fonds.

---

## 12. Hors périmètre

- Abonnement SaaS à Norya lui-même.
- Génération de factures PDF maison — on utilise les factures Stripe, qui
  portent la mention 293 B via le pied de facture du compte.
- Fichiers SEPA `pain.001`, devenus inutiles avec Connect.
- Reprise de commission sur impayé : tracée, pas automatisée.
- Relances automatiques d'impayés.

---

## 13. Questions ouvertes

1. **La base du CA** (§7) — à confirmer auprès d'un comptable ou de l'URSSAF.
   Par défaut : brut encaissé. Réglable en base, non bloquant.
2. **Compte bancaire professionnel** — absent à ce jour. Bloque les virements
   sortants en live, rien d'autre.
3. **Exposition SEPA à huit semaines** — un client peut faire annuler un
   prélèvement sans motif pendant huit semaines, après que la commission est
   partie. Tracé par `charge.dispute.created` ; la reprise reste manuelle.
4. **Coût de Connect Express** — compte actif facturé au mois, à confirmer sur
   la grille tarifaire Stripe France au moment de l'activation.

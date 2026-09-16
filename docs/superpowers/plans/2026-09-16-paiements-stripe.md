# Système de paiement Stripe — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Encaisser réellement les 800 € et les 49 €/mois via Stripe, verser automatiquement les 320 € de commission, et suivre le CA annuel face aux seuils de franchise de TVA.

**Architecture:** `index.html` (Cloudflare Pages) appelle trois Supabase Edge Functions en Deno. Le navigateur ne détient aucun secret et ne décide jamais qu'une vente est payée : seul le webhook Stripe, dont la signature est vérifiée, écrit `paid_at` et déclenche les transferts de commission.

**Tech Stack:** JavaScript vanilla (fichier unique), Supabase (Postgres + Edge Functions Deno), Stripe (Checkout, Billing, Connect Express), Cloudflare Pages.

**Spec:** [`docs/superpowers/specs/2026-09-16-paiements-stripe-design.md`](../specs/2026-09-16-paiements-stripe-design.md)

## Global Constraints

- `index.html` est **toute** l'application : un seul `<style>`, un seul `<script>` inline. Pas de React, pas de Tailwind, pas de TypeScript, pas de npm, pas d'étape de build côté front.
- Éditer `index.html` par un script Python dans le scratchpad utilisant `rep(old, new, n=1)` qui `assert` le nombre d'occurrences, ou par l'outil Edit sur des chaînes uniques. **Jamais** par heredoc Bash : les apostrophes françaises cassent, et la sortie Bash déforme le code.
- Après chaque modification de `index.html` : extraire les blocs `<script>` et les passer à `node --check`, **puis** charger la page réellement en écoutant `pageerror`. Le contrôle de syntaxe ne voit pas un `ReferenceError`.
- Le fichier définit `$` (`document.querySelector`) mais **pas** `$$`. Utiliser `document.querySelectorAll`.
- Ne jamais désactiver un bouton pour signaler un état : un bouton grisé se lit comme une panne. L'état se dit avec des mots.
- L'admin crée, le commercial reçoit. Dans l'espace d'un commercial, on écrit « Vous ».
- Jetons de thème existants uniquement : `--bg --surface --surface-2 --surface-3 --text --text-2 --muted --accent --amber --red --line --r-sm/md/lg`.
- Montants en **centimes entiers** partout côté serveur et en base. Jamais de flottant sur de l'argent.
- Barème, valeurs exactes : site `80000` centimes, maintenance `4900` centimes/mois, commission `32000` centimes, seuil franchise `3750000`, tolérance `4125000`.
- Aucune clé secrète Stripe dans `index.html`.
- Tests Puppeteer : `puppeteer-core` installé **dans le scratchpad** (`npm init -y && npm install puppeteer-core`), Chrome système à `C:/Program Files/Google/Chrome/Application/chrome.exe`. Ne pas polluer le dépôt.
- Jamais `el.offsetParent !== null` pour juger la visibilité : tous les écrans superposés de Norya sont en `position:fixed`. Mesurer la classe `hidden` + `getComputedStyle` + `getBoundingClientRect()`.
- Changer de vue dans un test par le code (`page.evaluate(v => { state.view = v; render(); }, vue)`), pas par un clic sur la nav : en mobile elle est dans un tiroir masqué.

---

## Structure des fichiers

```
supabase/
  config.toml                              # verify_jwt = false pour le webhook
  migrations/
    20260916120000_paiements_schema.sql    # colonnes + tables + index
    20260916120100_paiements_rls.sql       # politiques RLS
    20260916120200_fiscal_config.sql       # table fiscale + vue ca_annuel
  functions/
    _shared/
      config.ts        # constantes de montants, lues nulle part ailleurs
      stripe.ts        # client Stripe
      db.ts            # client Supabase service-role
      cors.ts          # en-têtes CORS
      ancre.ts         # ancre de facturation (pur, testé)
      ancre_test.ts
    create-checkout/index.ts
    connect-onboarding/index.ts
    stripe-webhook/
      index.ts         # HTTP, signature, idempotence, application des effets
      effets.ts        # décision pure : événement -> liste d'effets
      effets_test.ts
index.html                                 # modifié
```

Le découpage de `stripe-webhook` en `effets.ts` (pur) et `index.ts` (effets de bord) est délibéré : c'est ce qui rend la logique de versement testable sans réseau ni base. Toute la valeur des tests est là.

---

## Task 1 : Outillage, mise en ligne et objets Stripe de test

Rien de la suite n'est testable sans une URL `https` réelle : Stripe Checkout exige des URLs de retour, et le commercial doit ouvrir Norya sur son téléphone. Rien n'est testable non plus sans les deux `Price` Stripe, dont les identifiants sont consommés par la tâche 5.

**Files:**
- Create: `.gitignore` (ajout de lignes)

**Interfaces:**
- Produces:
  - `NORYA_URL` — l'URL publique de Norya, consommée par les tâches 5, 6 et 15.
  - `PRICE_SITE` — identifiant du prix ponctuel de 800 €, consommé par la tâche 5.
  - `PRICE_MAINTENANCE` — identifiant du prix récurrent de 49 €/mois, consommé par la tâche 5.

- [x] **Step 1: Installer les quatre CLI manquantes**

`node` et `npm` sont présents ; `deno`, `supabase`, `stripe` et `wrangler` sont absents.

```bash
winget install --id Stripe.StripeCLI --silent --accept-source-agreements --accept-package-agreements
npm install -g --allow-scripts=deno,esbuild,workerd supabase wrangler deno
```

`--allow-scripts` n'est pas optionnel : ce sont les scripts de
post-installation de `deno`, `esbuild` et `workerd` qui téléchargent leurs
binaires. Sans lui, npm signale « added 44 packages » et les commandes
échouent quand même.

- [x] **Step 2: Vérifier que les quatre répondent**

```bash
supabase --version && wrangler --version && deno --version && stripe --version
```

Expected: quatre numéros de version, aucun « command not found ».

winget modifie le `PATH` mais ne rafraîchit pas les shells déjà ouverts :
si `stripe` reste introuvable, ouvrir un nouveau terminal, ou l'appeler par
son chemin complet
`$LOCALAPPDATA/Microsoft/WinGet/Packages/Stripe.StripeCli_*/stripe.exe`.

- [x] **Step 3: Construire un dossier de publication propre**

```bash
rm -rf dist && mkdir -p dist && cp index.html dist/index.html
```

**Ne jamais déployer la racine du dépôt.** Elle contient
`prospects_norya.csv` — de vraies données de prospects, gitignorées
précisément pour cela — et une sauvegarde `.bak` de 234 Ko. `wrangler` ne
lit pas `.gitignore` : tout ce qui est dans le dossier pointé part en ligne.

- [x] **Step 4: Déployer**

`wrangler` délègue désormais `pages` vers Workers ; la voie classique exige
`--force`. On prend le successeur, qui fait la même chose pour un fichier
statique. Créer `wrangler.jsonc` :

```jsonc
{
  "name": "norya",
  "compatibility_date": "2026-09-15",
  "assets": { "directory": "./dist" }
}
```

puis :

```bash
wrangler login   # interactif : ouvre le navigateur par défaut
wrangler deploy
```

Expected: `Read 1 file from the assets directory` — **un seul**. Si wrangler
en annonce plusieurs, le dossier n'est pas propre : arrêter et vérifier.

L'URL renvoyée est `NORYA_URL`. Sur ce compte :
`https://norya.zx-zelph.workers.dev`.

- [x] **Step 5: Vérifier la mise en ligne et l'absence de fuite**

```bash
curl -s -o /dev/null -w "%{http_code} %{size_download}\n" https://norya.zx-zelph.workers.dev
curl -s -o /dev/null -w "%{http_code}\n" https://norya.zx-zelph.workers.dev/prospects_norya.csv
```

Expected: `200` avec la taille exacte d'`index.html`, puis `404`. Vérifier
aussi que la page déployée porte encore `const DEMO = true` : aucune donnée
réelle ne doit être atteignable avant la tâche 16.

Ajouter à `.gitignore` :

```
.wrangler/
supabase/.temp/
dist/
```

- [x] **Step 6: Authentifier le CLI Stripe**

À lancer dans un terminal interactif : la commande affiche un code
d'appariement et attend une validation dans le navigateur.

```bash
stripe login
```

Le navigateur par défaut s'ouvre sur la page de confirmation ; vérifier que
le code affiché correspond, puis confirmer. Le CLI se place en **mode test**
par défaut — aucune commande ci-dessous ne touche au mode live.

On passe par le CLI plutôt que par le tableau de bord parce que les objets
créés sont alors reproductibles, vérifiables, et consignés dans ce plan
plutôt que dans une suite de clics que personne ne peut rejouer.

- [x] **Step 7: Se placer sur le bon sandbox**

Ce compte en porte **deux**, et les objets créés dans l'un sont invisibles
depuis l'autre :

| Contexte | Compte |
|---|---|
| `Nova` | `acct_1UCXa9V05KpDxKCv` |
| `environnement de test Nova` | `acct_1UCXaLV05C1skoFg` ← retenu |

```bash
stripe switch context acct_1UCXaLV05C1skoFg
stripe config --list
```

Expected: `display_name = 'environnement de test Nova'`. Sans `--live`, on
reste en sandbox.

Le choix n'est pas cosmétique : les `price_...` doivent vivre dans le même
compte que la clé secrète posée à la tâche 15. Sinon le Checkout échoue sur
un « No such price », erreur d'autant plus coûteuse qu'elle ne dit pas que
le problème est un compte différent.

- [x] **Step 8: Créer les deux produits et leurs prix**

Les montants sont en **centimes** : `80000` et non `800`. Ni Stripe Tax ni
comportement fiscal — la structure est en franchise en base, les prix sont
les prix.

```bash
stripe products create \
  --name="Site internet" \
  --description="Création du site, facturée à la signature"

stripe products create \
  --name="Maintenance Norya" \
  --description="Hébergement et maintenance du site"
```

Puis, avec les `prod_...` renvoyés :

```bash
stripe prices create \
  --product=prod_SITE --currency=eur --unit-amount=80000

stripe prices create \
  --product=prod_MAINTENANCE --currency=eur --unit-amount=4900 \
  -d "recurring[interval]=month"
```

- [ ] **Step 9: Poser la mention de franchise sur les factures**

Dans le tableau de bord, Réglages → Facturation → Modèles de facture,
renseigner en pied de facture :

```
TVA non applicable, art. 293 B du CGI
```

Sans cette mention, les factures émises sont non conformes. C'est le seul
réglage de cette tâche qui n'a pas d'équivalent CLI.

- [x] **Step 10: Relever et vérifier les deux identifiants de prix**

```bash
stripe prices list --limit 10 2>/dev/null | sed -n '/^{/,$p'
```

Le `sed` n'est pas une coquetterie : le CLI préfixe sa sortie d'une ligne
« ▸ Running in … » et d'une balise `<claude-code-hint …/>`, qui font toutes
deux échouer `JSON.parse`.

Expected: deux prix, l'un `"type": "one_time"` à `80000`, l'autre
`"type": "recurring"` à `4900` avec `"interval": "month"`, tous deux en
`"currency": "eur"` et `"livemode": false`.

Valeurs obtenues sur le sandbox `environnement de test Nova` — **de test,
donc sans valeur de secret ; les identifiants live seront différents et
n'iront que dans les secrets Supabase** :

| Variable | Identifiant | Objet |
|---|---|---|
| `PRICE_SITE` | `price_1UG7ztV05C1skoFgYPbTxlSv` | `prod_VGfK2kdf3Dan3S` — 80000, ponctuel |
| `PRICE_MAINTENANCE` | `price_1UG7zuV05C1skoFgNc2xp1mo` | `prod_VGfKcjyUg6GjUu` — 4900, mensuel |

- [x] **Step 11: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore wrangler and supabase local artifacts"
```

Les identifiants de prix ne sont pas commités : ils iront dans les secrets
Supabase à la tâche 15.

---

## Task 2 : Schéma des paiements et RLS

**Files:**
- Create: `supabase/migrations/20260916120000_paiements_schema.sql`
- Create: `supabase/migrations/20260916120100_paiements_rls.sql`

**Interfaces:**
- Produces: tables `payments`, `commission_transfers`, `stripe_events` ; colonnes `profiles.stripe_account_id`, `profiles.stripe_payouts_enabled`, `prospects.stripe_customer_id`, `prospects.stripe_subscription_id`, `prospects.payment_status`. Consommées par les tâches 3, 5, 6, 7, 8, 11, 13, 14.

- [x] **Step 1: Écrire la migration de schéma**

`supabase/migrations/20260916120000_paiements_schema.sql` :

```sql
-- Colonnes ajoutées aux tables existantes
alter table profiles
  add column if not exists stripe_account_id      text,
  add column if not exists stripe_payouts_enabled boolean not null default false;

alter table prospects
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists payment_status         text not null default 'aucun';

alter table prospects
  add constraint prospects_payment_status_valide
  check (payment_status in ('aucun','en_cours','regle','echec','litige'));

-- Un encaissement, qu'il s'agisse du site ou d'un mois de maintenance
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

create index if not exists payments_prospect_idx     on payments(prospect_id);
create index if not exists payments_commercial_idx   on payments(commercial_id);
create index if not exists payments_paid_at_idx      on payments(paid_at);

-- Le versement des 320 EUR vers le compte Express du commercial
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

create unique index if not exists commission_transfers_payment_unique
  on commission_transfers(payment_id);

create index if not exists commission_transfers_attente_idx
  on commission_transfers(commercial_id)
  where status = 'en_attente_onboarding';

-- Idempotence : Stripe rejoue ses evenements, un rejeu ne doit rien refaire
create table if not exists stripe_events (
  id           text primary key,
  type         text not null,
  processed_at timestamptz not null default now()
);
```

L'index unique sur `commission_transfers(payment_id)` est la deuxième
ceinture : même si l'idempotence par `stripe_events` échouait, la base
refuserait une seconde commission sur le même encaissement.

- [x] **Step 2: Écrire la migration RLS**

`supabase/migrations/20260916120100_paiements_rls.sql` :

```sql
alter table payments             enable row level security;
alter table commission_transfers enable row level security;
alter table stripe_events        enable row level security;

-- Un commercial lit ses encaissements ; un administrateur lit tout.
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

-- Personne n'ecrit depuis le navigateur : seules les Edge Functions
-- ecrivent, en service_role, qui contourne RLS par construction.
-- stripe_events n'a aucune politique : il est invisible aux clients.
```

- [x] **Step 3: Appliquer les migrations sur la base locale**

```bash
supabase start
supabase db reset
```

Expected: les deux migrations s'appliquent sans erreur.

- [x] **Step 4: Vérifier les contraintes**

```bash
supabase db reset && psql "$(supabase status -o json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).DB_URL))")" -c "
  insert into payments (prospect_id, type, amount_cents, status)
  values (gen_random_uuid(), 'site', 80000, 'paye');
"
```

Expected: ÉCHEC avec une violation de clé étrangère sur `prospect_id` —
ce qui prouve que la contrainte mord.

- [x] **Step 5: Vérifier qu'un statut invalide est refusé**

```bash
psql "$DB_URL" -c "update prospects set payment_status = 'nimporte_quoi';"
```

Expected: ÉCHEC, `prospects_payment_status_valide` violée.

- [x] **Step 6: Commit**

```bash
git add supabase/migrations/20260916120000_paiements_schema.sql \
        supabase/migrations/20260916120100_paiements_rls.sql
git commit -m "feat(db): add payments, commission transfers and event ledger"
```

---

## Task 3 : Configuration fiscale et compteur de CA

C'est la réserve posée par le propriétaire : la base du CA en micro-entreprise
reste à confirmer, donc elle ne doit exister nulle part en dur.

**Files:**
- Create: `supabase/migrations/20260916120200_fiscal_config.sql`

**Interfaces:**
- Consumes: `payments`, `commission_transfers` (Task 2).
- Produces: table `fiscal_config`, vue `ca_annuel` exposant les colonnes
  `annee, ca_cents, seuil_franchise_cents, seuil_tolerance_cents, ca_base,
  regle_confirmee`. Consommée par la tâche 14.

- [x] **Step 1: Écrire la migration**

```sql
create table if not exists fiscal_config (
  annee                 integer primary key,
  ca_base               text    not null default 'brut_encaisse'
                          check (ca_base in ('brut_encaisse','net_commission')),
  seuil_franchise_cents integer not null default 3750000,
  seuil_tolerance_cents integer not null default 4125000,
  mention_facture       text    not null
                          default 'TVA non applicable, art. 293 B du CGI',
  regle_confirmee       boolean not null default false
);

insert into fiscal_config (annee) values (2026)
  on conflict (annee) do nothing;

alter table fiscal_config enable row level security;

create policy fiscal_lecture on fiscal_config for select
  using (auth.uid() is not null);

-- CA encaisse par annee civile, selon la base en vigueur cette annee-la.
-- En base 'net_commission' on retranche la commission reellement versee,
-- jamais une constante : le montant vit dans commission_transfers.
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
```

Le `left join` depuis `fiscal_config` — et non depuis `payments` — garantit
qu'une année sans aucun encaissement renvoie bien une ligne à `0`, plutôt
qu'aucune ligne. Sans cela la jauge de la tâche 14 n'afficherait rien du tout
au lieu d'afficher zéro.

- [x] **Step 2: Appliquer et vérifier le cas vide**

```bash
supabase db reset
psql "$DB_URL" -c "select * from ca_annuel where annee = 2026;"
```

Expected: une ligne, `ca_cents = 0`, `ca_base = brut_encaisse`,
`regle_confirmee = f`.

- [x] **Step 3: Vérifier les deux bases de calcul**

Insérer un prospect, un profil, un encaissement de 800 € et une commission
de 320 € versée, puis :

```bash
psql "$DB_URL" -c "select ca_cents from ca_annuel where annee = 2026;"
# attendu : 80000

psql "$DB_URL" -c "update fiscal_config set ca_base = 'net_commission' where annee = 2026;"
psql "$DB_URL" -c "select ca_cents from ca_annuel where annee = 2026;"
# attendu : 48000

psql "$DB_URL" -c "update fiscal_config set ca_base = 'brut_encaisse' where annee = 2026;"
```

Expected: `80000` puis `48000`. Basculer la règle est bien un `UPDATE`,
sans redéploiement ni modification de code.

- [x] **Step 4: Commit**

```bash
git add supabase/migrations/20260916120200_fiscal_config.sql
git commit -m "feat(db): add configurable fiscal rule and yearly revenue view"
```

---

## Task 4 : Modules partagés et ancre de facturation

L'ancre doit reproduire **exactement** `nextBilling()` de `index.html:6139`,
qui compare une date à minuit avec l'instant courant : le jour même du
prélèvement, la date bascule au mois suivant. Si le serveur en décidait
autrement, la date annoncée au client et la date facturée divergeraient.

**Files:**
- Create: `supabase/functions/_shared/config.ts`
- Create: `supabase/functions/_shared/stripe.ts`
- Create: `supabase/functions/_shared/db.ts`
- Create: `supabase/functions/_shared/cors.ts`
- Create: `supabase/functions/_shared/ancre.ts`
- Test: `supabase/functions/_shared/ancre_test.ts`

**Interfaces:**
- Produces:
  - `MONTANT_SITE_CENTS = 80000`, `MONTANT_MAINTENANCE_CENTS = 4900`, `COMMISSION_CENTS = 32000`
  - `stripe: Stripe`
  - `db(): SupabaseClient`
  - `CORS: Record<string,string>`, `reponse(corps: unknown, statut?: number): Response`
  - `ancreFacturation(jour: number, maintenant: Date): number` — horodatage **en secondes**, format attendu par Stripe.

- [x] **Step 1: Écrire le test de l'ancre**

`supabase/functions/_shared/ancre_test.ts` :

```ts
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { ancreFacturation } from "./ancre.ts";

const iso = (s: number) => new Date(s * 1000).toISOString();

Deno.test("jour a venir dans le mois courant", () => {
  const t = ancreFacturation(20, new Date("2026-09-16T14:00:00Z"));
  assertEquals(iso(t), "2026-09-20T00:00:00.000Z");
});

Deno.test("jour deja passe : mois suivant", () => {
  const t = ancreFacturation(5, new Date("2026-09-16T14:00:00Z"));
  assertEquals(iso(t), "2026-10-05T00:00:00.000Z");
});

Deno.test("le jour meme bascule au mois suivant, comme nextBilling", () => {
  const t = ancreFacturation(16, new Date("2026-09-16T14:00:00Z"));
  assertEquals(iso(t), "2026-10-16T00:00:00.000Z");
});

Deno.test("passage d'annee", () => {
  const t = ancreFacturation(5, new Date("2026-12-20T09:00:00Z"));
  assertEquals(iso(t), "2027-01-05T00:00:00.000Z");
});

Deno.test("le 28 reste valide en fevrier", () => {
  const t = ancreFacturation(28, new Date("2027-01-29T09:00:00Z"));
  assertEquals(iso(t), "2027-02-28T00:00:00.000Z");
});

Deno.test("jour hors plage refuse", () => {
  assertThrows(() => ancreFacturation(0,  new Date()), Error, "1 et 28");
  assertThrows(() => ancreFacturation(29, new Date()), Error, "1 et 28");
});
```

- [x] **Step 2: Lancer le test, vérifier qu'il échoue**

```bash
deno test supabase/functions/_shared/ancre_test.ts --allow-all
```

Expected: ÉCHEC — `Module not found "./ancre.ts"`.

- [x] **Step 3: Écrire l'ancre**

`supabase/functions/_shared/ancre.ts` :

```ts
/** Horodatage Stripe (secondes) du prochain prelevement au jour donne.
 *  Reproduit nextBilling() de index.html : le jour meme, on bascule au
 *  mois suivant, car la date a minuit est deja passee. */
export function ancreFacturation(jour: number, maintenant: Date): number {
  if (!Number.isInteger(jour) || jour < 1 || jour > 28) {
    throw new Error("Le jour de prelevement doit etre entre 1 et 28.");
  }
  const d = new Date(Date.UTC(
    maintenant.getUTCFullYear(), maintenant.getUTCMonth(), jour,
  ));
  if (d.getTime() <= maintenant.getTime()) {
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return Math.floor(d.getTime() / 1000);
}
```

- [x] **Step 4: Lancer le test, vérifier qu'il passe**

```bash
deno test supabase/functions/_shared/ancre_test.ts --allow-all
```

Expected: `ok | 6 passed | 0 failed`.

- [x] **Step 5: Écrire les trois autres modules partagés**

`supabase/functions/_shared/config.ts` :

```ts
/** Bareme Norya. Ces montants ne viennent JAMAIS de la requete du
 *  navigateur : ils sont fixes ici et dans les objets Price de Stripe. */
export const MONTANT_SITE_CENTS        = 80000;
export const MONTANT_MAINTENANCE_CENTS = 4900;
export const COMMISSION_CENTS          = 32000;
```

`supabase/functions/_shared/stripe.ts` :

```ts
import Stripe from "npm:stripe@17.7.0";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2025-02-24.acacia",
  // Deno n'a pas le crypto synchrone : sans ce client, constructEvent echoue.
  httpClient: Stripe.createFetchHttpClient(),
});
```

`supabase/functions/_shared/db.ts` :

```ts
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Client service_role : contourne RLS. Reserve aux Edge Functions. */
export function db(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
```

`supabase/functions/_shared/cors.ts` :

```ts
export const CORS = {
  "Access-Control-Allow-Origin":  Deno.env.get("NORYA_URL") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function reponse(corps: unknown, statut = 200): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
```

- [x] **Step 6: Vérifier que tout se type et se charge**

```bash
deno check supabase/functions/_shared/*.ts
```

Expected: aucune erreur.

- [x] **Step 7: Commit**

```bash
git add supabase/functions/_shared/
git commit -m "feat(functions): add shared modules and tested billing anchor"
```

---

## Task 5 : Edge Function create-checkout

**Files:**
- Create: `supabase/functions/create-checkout/index.ts`

**Interfaces:**
- Consumes: `ancreFacturation`, `stripe`, `db`, `reponse`, `CORS` (Task 4) ; colonnes de la Task 2 ; `NORYA_URL` (Task 1).
- Produces: `POST /functions/v1/create-checkout`, corps `{ prospect_id: string, billing_day: number }`, réponse `{ url: string }`. Consommée par la tâche 9.

- [x] **Step 1: Écrire la fonction**

```ts
import { stripe } from "../_shared/stripe.ts";
import { db } from "../_shared/db.ts";
import { reponse, CORS } from "../_shared/cors.ts";
import { ancreFacturation } from "../_shared/ancre.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const jeton = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jeton) return reponse({ error: "Authentification requise." }, 401);

  const sb = db();
  const { data: { user }, error: errAuth } = await sb.auth.getUser(jeton);
  if (errAuth || !user) return reponse({ error: "Session invalide." }, 401);

  const { prospect_id, billing_day } = await req.json();

  const { data: fiche } = await sb.from("prospects")
    .select("id, company_name, email, assigned_to, paid_at, stripe_customer_id")
    .eq("id", prospect_id).single();
  if (!fiche) return reponse({ error: "Fiche introuvable." }, 404);

  // Le navigateur a beau avoir verifie : on refait tout ici.
  const { data: moi } = await sb.from("profiles")
    .select("role").eq("id", user.id).single();
  if (fiche.assigned_to !== user.id && moi?.role !== "admin") {
    return reponse({ error: "Cette fiche ne vous est pas attribuee." }, 403);
  }
  if (fiche.paid_at) {
    return reponse({ error: "Cette vente est deja encaissee." }, 409);
  }
  if (!fiche.email) {
    return reponse({ error: "La fiche n'a pas d'adresse e-mail." }, 422);
  }

  let ancre: number;
  try {
    ancre = ancreFacturation(Number(billing_day), new Date());
  } catch (e) {
    return reponse({ error: (e as Error).message }, 422);
  }

  let clientId = fiche.stripe_customer_id;
  if (!clientId) {
    const c = await stripe.customers.create({
      email: fiche.email,
      name:  fiche.company_name,
      metadata: { prospect_id: fiche.id },
    });
    clientId = c.id;
    await sb.from("prospects")
      .update({ stripe_customer_id: clientId }).eq("id", fiche.id);
  }

  const racine = Deno.env.get("NORYA_URL")!;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: clientId,
    line_items: [
      { price: Deno.env.get("PRICE_MAINTENANCE")!, quantity: 1 },
      { price: Deno.env.get("PRICE_SITE")!,        quantity: 1 },
    ],
    payment_method_types: ["card", "sepa_debit"],
    locale: "fr",
    subscription_data: {
      billing_cycle_anchor: ancre,
      proration_behavior:   "none",
      metadata: { prospect_id: fiche.id, commercial_id: fiche.assigned_to ?? "" },
    },
    metadata: { prospect_id: fiche.id, commercial_id: fiche.assigned_to ?? "" },
    success_url: `${racine}/?paiement=ok&fiche=${fiche.id}`,
    cancel_url:  `${racine}/?paiement=annule&fiche=${fiche.id}`,
  });

  await sb.from("prospects")
    .update({ payment_status: "en_cours", billing_day: Number(billing_day) })
    .eq("id", fiche.id);

  return reponse({ url: session.url });
});
```

Le prix ponctuel des 800 € est placé **après** le prix récurrent dans
`line_items` : en mode `subscription`, un prix ponctuel n'apparaît que sur la
première facture, ce qui encaisse le site et arme la maintenance en une seule
opération.

- [x] **Step 2: Vérifier le typage**

```bash
deno check supabase/functions/create-checkout/index.ts
```

Expected: aucune erreur.

- [x] **Step 3: Vérifier qu'une requête sans jeton est refusée**

```bash
supabase functions serve create-checkout --no-verify-jwt &
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:54321/functions/v1/create-checkout \
  -H "Content-Type: application/json" -d '{"prospect_id":"x","billing_day":5}'
```

Expected: `401`.

- [x] **Step 4: Commit**

```bash
git add supabase/functions/create-checkout/
git commit -m "feat(functions): add create-checkout"
```

---

## Task 6 : Edge Function connect-onboarding

**Files:**
- Create: `supabase/functions/connect-onboarding/index.ts`

**Interfaces:**
- Consumes: `stripe`, `db`, `reponse`, `CORS` (Task 4) ; `profiles.stripe_account_id` (Task 2).
- Produces: `POST /functions/v1/connect-onboarding`, corps vide, réponse `{ url: string }`. Consommée par les tâches 12 et 13.

- [x] **Step 1: Écrire la fonction**

```ts
import { stripe } from "../_shared/stripe.ts";
import { db } from "../_shared/db.ts";
import { reponse, CORS } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const jeton = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jeton) return reponse({ error: "Authentification requise." }, 401);

  const sb = db();
  const { data: { user }, error: errAuth } = await sb.auth.getUser(jeton);
  if (errAuth || !user) return reponse({ error: "Session invalide." }, 401);

  const { data: profil } = await sb.from("profiles")
    .select("id, email, full_name, stripe_account_id").eq("id", user.id).single();
  if (!profil) return reponse({ error: "Profil introuvable." }, 404);

  // Idempotent : rappele, on renvoie un nouveau lien vers le meme compte.
  let compte = profil.stripe_account_id;
  if (!compte) {
    const c = await stripe.accounts.create({
      type: "express",
      country: "FR",
      email: profil.email ?? undefined,
      business_type: "individual",
      capabilities: { transfers: { requested: true } },
      metadata: { profile_id: profil.id },
    });
    compte = c.id;
    await sb.from("profiles")
      .update({ stripe_account_id: compte }).eq("id", profil.id);
  }

  const racine = Deno.env.get("NORYA_URL")!;
  const lien = await stripe.accountLinks.create({
    account: compte,
    type: "account_onboarding",
    refresh_url: `${racine}/?stripe=reprendre`,
    return_url:  `${racine}/?stripe=termine`,
  });

  return reponse({ url: lien.url });
});
```

- [x] **Step 2: Vérifier le typage**

```bash
deno check supabase/functions/connect-onboarding/index.ts
```

Expected: aucune erreur.

- [x] **Step 3: Vérifier le refus sans jeton**

```bash
supabase functions serve connect-onboarding --no-verify-jwt &
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:54321/functions/v1/connect-onboarding
```

Expected: `401`.

- [x] **Step 4: Commit**

```bash
git add supabase/functions/connect-onboarding/
git commit -m "feat(functions): add Connect Express onboarding"
```

---

## Task 7 : Décision du webhook, en pur

Le cœur du système. Aucun réseau, aucune base : une fonction qui prend un
événement Stripe et l'état connu, et renvoie la liste des effets à appliquer.
C'est ce qui rend la règle de versement réellement testable.

**Files:**
- Create: `supabase/functions/stripe-webhook/effets.ts`
- Test: `supabase/functions/stripe-webhook/effets_test.ts`

**Interfaces:**
- Consumes: `COMMISSION_CENTS`, `MONTANT_SITE_CENTS` (Task 4).
- Produces:
  - `type Effet` (union discriminée, huit variantes ci-dessous)
  - `type Contexte = { commercialOnboarde: boolean }`
  - `effetsPour(event: { type: string; data: { object: Record<string, unknown> } }, ctx: Contexte): Effet[]`
  Consommés par la tâche 8.

- [x] **Step 1: Écrire les tests**

`supabase/functions/stripe-webhook/effets_test.ts` :

```ts
import { assertEquals } from "jsr:@std/assert";
import { effetsPour } from "./effets.ts";

const ONBOARDE     = { commercialOnboarde: true };
const NON_ONBOARDE = { commercialOnboarde: false };

const facture = (extra: Record<string, unknown> = {}) => ({
  type: "invoice.paid",
  data: { object: {
    id: "in_1", billing_reason: "subscription_create",
    amount_paid: 84900, payment_intent: "pi_1",
    subscription_details: { metadata: {
      prospect_id: "pr_1", commercial_id: "co_1",
    } },
    ...extra,
  } },
});

Deno.test("session terminee : on rattache, on ne paie pas", () => {
  const e = effetsPour({
    type: "checkout.session.completed",
    data: { object: {
      customer: "cus_1", subscription: "sub_1",
      metadata: { prospect_id: "pr_1" },
    } },
  }, ONBOARDE);

  assertEquals(e, [{
    type: "rattacher_client", prospectId: "pr_1",
    customerId: "cus_1", subscriptionId: "sub_1",
  }]);
});

Deno.test("premiere facture : encaissement, paid_at, commission", () => {
  const e = effetsPour(facture(), ONBOARDE);
  assertEquals(e.map((x) => x.type), [
    "enregistrer_paiement", "marquer_paye", "verser_commission",
  ]);
  assertEquals(e[0], {
    type: "enregistrer_paiement", prospectId: "pr_1", commercialId: "co_1",
    nature: "site", montantCents: 80000,
    invoiceId: "in_1", paymentIntentId: "pi_1",
  });
  assertEquals(e[2], {
    type: "verser_commission", prospectId: "pr_1",
    commercialId: "co_1", montantCents: 32000,
  });
});

Deno.test("premiere facture, commercial non verifie : on met en file", () => {
  const e = effetsPour(facture(), NON_ONBOARDE);
  assertEquals(e.map((x) => x.type), [
    "enregistrer_paiement", "marquer_paye", "mettre_en_file",
  ]);
});

Deno.test("facture de maintenance : aucune commission", () => {
  const e = effetsPour(
    facture({ billing_reason: "subscription_cycle", amount_paid: 4900 }),
    ONBOARDE,
  );
  assertEquals(e.map((x) => x.type), ["enregistrer_paiement"]);
  assertEquals(e[0], {
    type: "enregistrer_paiement", prospectId: "pr_1", commercialId: "co_1",
    nature: "maintenance", montantCents: 4900,
    invoiceId: "in_1", paymentIntentId: "pi_1",
  });
});

Deno.test("echec de paiement", () => {
  assertEquals(effetsPour({
    type: "invoice.payment_failed",
    data: { object: { subscription_details: {
      metadata: { prospect_id: "pr_1" },
    } } },
  }, ONBOARDE), [{
    type: "marquer_statut", prospectId: "pr_1", statut: "echec",
  }]);
});

Deno.test("litige", () => {
  assertEquals(effetsPour({
    type: "charge.dispute.created",
    data: { object: { metadata: { prospect_id: "pr_1" } } },
  }, ONBOARDE), [{
    type: "marquer_statut", prospectId: "pr_1", statut: "litige",
  }]);
});

Deno.test("compte verifie : on rejoue la file", () => {
  assertEquals(effetsPour({
    type: "account.updated",
    data: { object: { id: "acct_1", payouts_enabled: true } },
  }, ONBOARDE), [
    { type: "maj_compte", compteId: "acct_1", payoutsActifs: true },
    { type: "rejouer_file",    compteId: "acct_1" },
  ]);
});

Deno.test("compte encore incomplet : pas de rejeu", () => {
  assertEquals(effetsPour({
    type: "account.updated",
    data: { object: { id: "acct_1", payouts_enabled: false } },
  }, ONBOARDE), [
    { type: "maj_compte", compteId: "acct_1", payoutsActifs: false },
  ]);
});

Deno.test("evenement inconnu : aucun effet", () => {
  assertEquals(effetsPour({
    type: "customer.created", data: { object: {} },
  }, ONBOARDE), []);
});
```

- [x] **Step 2: Lancer les tests, vérifier qu'ils échouent**

```bash
deno test supabase/functions/stripe-webhook/effets_test.ts --allow-all
```

Expected: ÉCHEC — `Module not found "./effets.ts"`.

- [x] **Step 3: Écrire la décision**

`supabase/functions/stripe-webhook/effets.ts` :

```ts
import { COMMISSION_CENTS, MONTANT_SITE_CENTS } from "../_shared/config.ts";

export type Effet =
  | { type: "rattacher_client"; prospectId: string;
      customerId: string; subscriptionId: string }
  | { type: "enregistrer_paiement"; prospectId: string;
      commercialId: string | null; nature: "site" | "maintenance";
      montantCents: number; invoiceId: string; paymentIntentId: string | null }
  | { type: "marquer_paye"; prospectId: string }
  | { type: "verser_commission"; prospectId: string;
      commercialId: string; montantCents: number }
  | { type: "mettre_en_file"; prospectId: string;
      commercialId: string; montantCents: number }
  | { type: "marquer_statut"; prospectId: string; statut: string }
  | { type: "maj_compte"; compteId: string; payoutsActifs: boolean }
  | { type: "rejouer_file"; compteId: string };

export type Contexte = { commercialOnboarde: boolean };

type Evenement = { type: string; data: { object: Record<string, any> } };

export function effetsPour(ev: Evenement, ctx: Contexte): Effet[] {
  const o = ev.data.object;

  switch (ev.type) {
    case "checkout.session.completed":
      // Volontairement pas de marquer_paye : en SEPA, rien n'est acquis
      // a ce stade. C'est invoice.paid qui tranche.
      return [{
        type: "rattacher_client",
        prospectId:     o.metadata?.prospect_id,
        customerId:     o.customer,
        subscriptionId: o.subscription,
      }];

    case "invoice.paid": {
      const meta         = o.subscription_details?.metadata ?? {};
      const prospectId   = meta.prospect_id;
      const commercialId = meta.commercial_id || null;
      const premiere     = o.billing_reason === "subscription_create";

      const effets: Effet[] = [{
        type: "enregistrer_paiement",
        prospectId, commercialId,
        nature:       premiere ? "site" : "maintenance",
        montantCents: premiere ? MONTANT_SITE_CENTS : o.amount_paid,
        invoiceId:       o.id,
        paymentIntentId: o.payment_intent ?? null,
      }];

      if (!premiere) return effets;

      effets.push({ type: "marquer_paye", prospectId });

      // La maintenance ne commissionne pas : seule la premiere facture.
      if (commercialId) {
        effets.push({
          type: ctx.commercialOnboarde ? "verser_commission" : "mettre_en_file",
          prospectId, commercialId, montantCents: COMMISSION_CENTS,
        });
      }
      return effets;
    }

    case "invoice.payment_failed":
      return [{
        type: "marquer_statut",
        prospectId: o.subscription_details?.metadata?.prospect_id,
        statut: "echec",
      }];

    case "charge.dispute.created":
      return [{
        type: "marquer_statut",
        prospectId: o.metadata?.prospect_id,
        statut: "litige",
      }];

    case "account.updated": {
      const effets: Effet[] = [{
        type: "maj_compte",
        compteId: o.id, payoutsActifs: !!o.payouts_enabled,
      }];
      if (o.payouts_enabled) {
        effets.push({ type: "rejouer_file", compteId: o.id });
      }
      return effets;
    }

    default:
      return [];
  }
}
```

Noter `montantCents: premiere ? MONTANT_SITE_CENTS : o.amount_paid`. Sur la
première facture, `amount_paid` vaut 849 € — les 800 € du site *plus* le
premier mois de maintenance. Enregistrer ce total comme prix du site
fausserait le compteur de CA et les 320 € de commission. On prend la
constante.

- [x] **Step 4: Lancer les tests, vérifier qu'ils passent**

```bash
deno test supabase/functions/stripe-webhook/effets_test.ts --allow-all
```

Expected: `ok | 9 passed | 0 failed`.

- [x] **Step 5: Commit**

```bash
git add supabase/functions/stripe-webhook/effets.ts \
        supabase/functions/stripe-webhook/effets_test.ts
git commit -m "feat(functions): add tested webhook decision logic"
```

---

## Task 8 : Webhook HTTP, signature et idempotence

**Files:**
- Create: `supabase/functions/stripe-webhook/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: `effetsPour`, `Effet` (Task 7) ; `stripe`, `db` (Task 4) ; tables de la Task 2.
- Produces: `POST /functions/v1/stripe-webhook`, sans JWT, signature obligatoire.

- [x] **Step 1: Désactiver la vérification JWT sur ce seul point d'entrée**

Dans `supabase/config.toml` :

```toml
[functions.stripe-webhook]
verify_jwt = false
```

Stripe n'a pas de JWT Supabase. C'est la signature qui authentifie, pas le jeton.

- [x] **Step 2: Écrire la fonction**

```ts
import { stripe } from "../_shared/stripe.ts";
import { db } from "../_shared/db.ts";
import { effetsPour, type Effet } from "./effets.ts";

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Signature absente", { status: 400 });

  const brut = await req.text();
  let ev;
  try {
    // constructEventAsync, pas constructEvent : Deno n'a pas le crypto
    // synchrone que la variante bloquante exige.
    ev = await stripe.webhooks.constructEventAsync(
      brut, signature, Deno.env.get("STRIPE_WEBHOOK_SECRET")!,
    );
  } catch (e) {
    return new Response(`Signature invalide : ${(e as Error).message}`,
                        { status: 400 });
  }

  const sb = db();

  // Idempotence d'abord : Stripe rejoue, et un rejeu ne doit jamais
  // verser une seconde commission. Le conflit de cle primaire fait foi.
  const { error: conflit } = await sb.from("stripe_events")
    .insert({ id: ev.id, type: ev.type });
  if (conflit) return new Response("Deja traite", { status: 200 });

  const ctx = { commercialOnboarde: await onboarde(sb, ev) };

  for (const effet of effetsPour(ev as never, ctx)) {
    await appliquer(sb, effet);
  }
  return new Response("ok", { status: 200 });
});

async function onboarde(sb: ReturnType<typeof db>, ev: any): Promise<boolean> {
  const id = ev.data?.object?.subscription_details?.metadata?.commercial_id;
  if (!id) return false;
  const { data } = await sb.from("profiles")
    .select("stripe_payouts_enabled").eq("id", id).single();
  return !!data?.stripe_payouts_enabled;
}

async function appliquer(sb: ReturnType<typeof db>, e: Effet): Promise<void> {
  switch (e.type) {
    case "rattacher_client":
      await sb.from("prospects").update({
        stripe_customer_id: e.customerId,
        stripe_subscription_id: e.subscriptionId,
      }).eq("id", e.prospectId);
      return;

    case "enregistrer_paiement":
      await sb.from("payments").insert({
        prospect_id: e.prospectId, commercial_id: e.commercialId,
        type: e.nature, amount_cents: e.montantCents,
        stripe_invoice_id: e.invoiceId,
        stripe_payment_intent_id: e.paymentIntentId,
        status: "paye", paid_at: new Date().toISOString(),
      });
      return;

    case "marquer_paye":
      await sb.from("prospects").update({
        paid_at: new Date().toISOString(), payment_status: "regle",
      }).eq("id", e.prospectId);
      return;

    case "marquer_statut":
      await sb.from("prospects")
        .update({ payment_status: e.statut }).eq("id", e.prospectId);
      return;

    case "verser_commission":
    case "mettre_en_file": {
      const { data: paiement } = await sb.from("payments")
        .select("id").eq("prospect_id", e.prospectId)
        .eq("type", "site").single();
      if (!paiement) return;

      if (e.type === "mettre_en_file") {
        await sb.from("commission_transfers").insert({
          payment_id: paiement.id, commercial_id: e.commercialId,
          amount_cents: e.montantCents, status: "en_attente_onboarding",
        });
        return;
      }

      const { data: profil } = await sb.from("profiles")
        .select("stripe_account_id").eq("id", e.commercialId).single();
      if (!profil?.stripe_account_id) return;

      const t = await stripe.transfers.create({
        amount: e.montantCents, currency: "eur",
        destination: profil.stripe_account_id,
        metadata: { prospect_id: e.prospectId, payment_id: paiement.id },
      });
      await sb.from("commission_transfers").insert({
        payment_id: paiement.id, commercial_id: e.commercialId,
        amount_cents: e.montantCents,
        stripe_transfer_id: t.id, status: "verse",
      });
      return;
    }

    case "maj_compte":
      await sb.from("profiles")
        .update({ stripe_payouts_enabled: e.payoutsActifs })
        .eq("stripe_account_id", e.compteId);
      return;

    case "rejouer_file": {
      const { data: profil } = await sb.from("profiles")
        .select("id").eq("stripe_account_id", e.compteId).single();
      if (!profil) return;

      const { data: attente } = await sb.from("commission_transfers")
        .select("id, payment_id, amount_cents")
        .eq("commercial_id", profil.id)
        .eq("status", "en_attente_onboarding");

      for (const ligne of attente ?? []) {
        const t = await stripe.transfers.create({
          amount: ligne.amount_cents, currency: "eur",
          destination: e.compteId,
          metadata: { payment_id: ligne.payment_id },
        });
        await sb.from("commission_transfers")
          .update({ stripe_transfer_id: t.id, status: "verse" })
          .eq("id", ligne.id);
      }
      return;
    }
  }
}
```

- [x] **Step 3: Vérifier le typage**

```bash
deno check supabase/functions/stripe-webhook/index.ts
```

Expected: aucune erreur.

- [x] **Step 4: Vérifier qu'une requête non signée est rejetée**

```bash
supabase functions serve stripe-webhook --no-verify-jwt &
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  http://localhost:54321/functions/v1/stripe-webhook -d '{"type":"invoice.paid"}'
```

Expected: `400`. Un webhook qui accepterait ce corps laisserait n'importe
qui déclencher un virement de 320 €.

- [x] **Step 5: Vérifier l'idempotence sur un rejeu réel**

```bash
stripe listen --forward-to http://localhost:54321/functions/v1/stripe-webhook &
stripe trigger invoice.paid
# noter l'id d'evenement, puis le rejouer :
stripe events resend <evt_id>
psql "$DB_URL" -c "select count(*) from commission_transfers;"
```

Expected: `1`. Pas `2`.

- [x] **Step 6: Commit**

```bash
git add supabase/functions/stripe-webhook/index.ts supabase/config.toml
git commit -m "feat(functions): add signed, idempotent Stripe webhook"
```

---

## Task 9 : Accès store côté navigateur, avec garde démonstration

`index.html:3023` fait `if (DEMO) Object.assign(store, demoStore);`. C'est le
point d'accroche naturel de la garde : la version de démonstration ne touche
jamais le réseau, donc un profil d'essai ne peut structurellement pas
déclencher un vrai paiement.

**Files:**
- Modify: `index.html` (objet `store` vers 2447, objet `demoStore` vers 2862)

**Interfaces:**
- Consumes: `create-checkout` (Task 5), `connect-onboarding` (Task 6).
- Produces: `store.createCheckout(prospectId, billingDay) -> Promise<{url}>`,
  `store.connectOnboarding() -> Promise<{url}>`,
  `store.caAnnuel() -> Promise<{annee, ca_cents, seuil_franchise_cents, seuil_tolerance_cents, ca_base, regle_confirmee}|null>`.
  Consommés par les tâches 10, 12, 13, 14.

- [x] **Step 1: Écrire le test de la garde**

`scratchpad/test-garde-demo.mjs` :

```js
import puppeteer from "puppeteer-core";

const nav = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
});
const page = await nav.newPage();

const appels = [];
page.on("request", (r) => {
  if (r.url().includes("/functions/v1/")) appels.push(r.url());
});
const erreurs = [];
page.on("pageerror", (e) => erreurs.push(e.message));

await page.goto("file:///C:/Users/PC/Downloads/Norya/index.html",
                { waitUntil: "networkidle0" });

const res = await page.evaluate(async () => {
  try { return { ok: true, r: await store.createCheckout("p1", 5) }; }
  catch (e) { return { ok: false, msg: e.message }; }
});

const rapport = [
  `DEMO actif        : ${await page.evaluate(() => DEMO)}`,
  `appels reseau     : ${appels.length}  ${appels.join(", ")}`,
  `erreurs de page   : ${erreurs.length} ${erreurs.join(" | ")}`,
  `retour createCheckout : ${JSON.stringify(res)}`,
].join("\n");

await import("node:fs").then((fs) =>
  fs.writeFileSync("scratchpad/resultat-garde-demo.txt", rapport));
await nav.close();
```

- [x] **Step 2: Lancer le test, vérifier qu'il échoue**

```bash
cd scratchpad && npm init -y && npm install puppeteer-core && cd ..
node scratchpad/test-garde-demo.mjs
```

Expected: `retour createCheckout` signale `store.createCheckout is not a
function` — la méthode n'existe pas encore.

- [x] **Step 3: Ajouter les trois méthodes réelles au store**

Dans `index.html`, juste après `async commissions(){ … }` de l'objet `store`
(vers la ligne 2450), insérer :

```js
  /* --- Paiements Stripe ---
     Le navigateur ne connaît aucun montant ni aucune clé : il demande une
     URL de Checkout et y redirige. Tout est décidé côté Edge Function. */
  async _invoke(nom, corps){
    const { data: { session } } = await sb.auth.getSession();
    const r = await fetch(`${CONFIG.url}/functions/v1/${nom}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session?.access_token ?? ""}`
      },
      body: JSON.stringify(corps || {})
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || "Le service de paiement n'a pas répondu.");
    return out;
  },
  async createCheckout(prospectId, billingDay){
    return this._invoke("create-checkout",
      { prospect_id: prospectId, billing_day: billingDay });
  },
  async connectOnboarding(){
    return this._invoke("connect-onboarding");
  },
  async caAnnuel(){
    const { data, error } = await sb.from("ca_annuel")
      .select("*").eq("annee", new Date().getFullYear()).maybeSingle();
    if (error) throw error; return data;
  },
```

- [x] **Step 4: Ajouter les versions de démonstration**

Dans `demoStore`, juste après `async commissions(){ return []; }`
(vers la ligne 2862), insérer :

```js
  /* En démonstration, aucun appel réseau : un profil d'essai ne doit
     jamais pouvoir déclencher un paiement réel. */
  async createCheckout(){
    throw new Error("Les paiements sont désactivés dans le profil d'essai.");
  },
  async connectOnboarding(){
    throw new Error("Les paiements sont désactivés dans le profil d'essai.");
  },
  async caAnnuel(){
    const ca = this._prospects
      .filter(p => p.paid_at).length * SITE_PRICE * 100;
    return { annee: new Date().getFullYear(), ca_cents: ca,
             seuil_franchise_cents: 3750000, seuil_tolerance_cents: 4125000,
             ca_base: "brut_encaisse", regle_confirmee: false };
  },
```

- [x] **Step 5: Contrôler la syntaxe puis relancer le test**

```bash
node scratchpad/verif-syntaxe.mjs   # extrait les <script>, node --check chacun
node scratchpad/test-garde-demo.mjs
```

Expected: `appels reseau : 0`, `erreurs de page : 0`, et `createCheckout`
renvoie `ok:false` avec « désactivés dans le profil d'essai ». Zéro appel
réseau est l'assertion qui compte.

- [x] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: add Stripe store methods with demo-mode guard"
```

---

## Task 10 : Flux « Encaisser » depuis la fiche prospect

Le jour de prélèvement passe **avant** le paiement, puisqu'il détermine
`billing_cycle_anchor`. `billingForm()` (index.html:7613) perd donc son rôle
de réglage a posteriori pour les ventes Stripe.

**Files:**
- Modify: `index.html` — `billingForm()` vers 7613, `closeSaleForm()` vers 7262

**Interfaces:**
- Consumes: `store.createCheckout` (Task 9), `nextBilling` (index.html:6139).
- Produces: `encaisserForm(id)`, appelée depuis la fiche prospect.

- [x] **Step 1: Écrire le test de la modale**

`scratchpad/test-encaisser.mjs` — charge la page, ouvre `encaisserForm("p1")`,
et vérifie trois choses : la modale s'affiche, le bouton n'est jamais
`disabled`, et le récapitulatif annonce bien 800 € puis 49 €.

```js
const etat = await page.evaluate(() => {
  encaisserForm("p1");
  const m   = document.querySelector(".modal");
  const btn = document.querySelector("#encaisser");
  return {
    visible:  !!m && getComputedStyle(m).display !== "none"
              && m.getBoundingClientRect().height > 0,
    disabled: btn ? btn.disabled : null,
    texte:    m ? m.textContent.replace(/\s+/g, " ") : "",
  };
});
```

Assertions : `visible === true`, `disabled === false`, `texte` contient
`800` et `49`.

- [x] **Step 2: Lancer, vérifier l'échec**

```bash
node scratchpad/test-encaisser.mjs
```

Expected: `encaisserForm is not defined`.

- [x] **Step 3: Remplacer billingForm par encaisserForm**

Dans `index.html`, remplacer tout le corps de `billingForm(id)` par :

```js
/* ---------- Encaissement d'une vente ----------
   Le jour de prélèvement est choisi ici, avant le paiement : il fixe
   l'ancre de facturation Stripe. Le navigateur n'écrit jamais paid_at —
   c'est le webhook qui tranche, une fois la banque d'accord. */
function encaisserForm(id){
  const p = findProspect(id);
  if (!p) { toast("Fiche introuvable.", "err"); return; }
  const days = Array.from({length:28}, (_,i) => i+1);
  const m = modal({
    title: "Encaisser — " + p.company_name,
    body: `
      <p style="margin:0 0 16px;color:var(--muted);font-size:13px">
        Le client règle ${eur(SITE_PRICE)} maintenant, par carte ou par
        prélèvement, puis ${eur(MAINTENANCE_FEE)} le jour choisi de chaque mois.
        Le même moyen de paiement sert pour les deux.</p>
      <div class="field"><label for="b_day">Jour du prélèvement mensuel</label>
        <select class="select" id="b_day">
          ${days.map(d => `<option value="${d}" ${p.billing_day===d?"selected":""}>Le ${d} de chaque mois</option>`).join("")}
        </select></div>
      <div id="b_next" class="alert ok"></div>
      <div id="b_err" class="alert err" style="display:none"></div>
    `,
    footer: `<button class="ihb ihb-ghost" id="cancel"><span class="ihb-label">Annuler</span><span class="ihb-fly"><span>Annuler</span><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></span><span class="ihb-dot" aria-hidden="true"></span></button>
             <button class="ihb" id="encaisser"><span class="ihb-label">Ouvrir le paiement</span><span class="ihb-fly"><span>Ouvrir le paiement</span><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></span><span class="ihb-dot" aria-hidden="true"></span></button>`
  });

  const sel  = m.querySelector("#b_day");
  const note = m.querySelector("#b_next");
  const err  = m.querySelector("#b_err");
  const preview = () => {
    note.textContent = "Première maintenance prélevée le " + nextBilling(Number(sel.value));
  };
  sel.onchange = preview; preview();

  m.querySelector("#cancel").onclick = closeModal;

  /* Le bouton reste cliquable en toute circonstance : s'il manque
     quelque chose, c'est la modale qui le dit, pas un bouton grisé. */
  m.querySelector("#encaisser").onclick = async () => {
    err.style.display = "none";
    const btn = m.querySelector("#encaisser");
    btnLabel(btn, "Ouverture…");
    try {
      const { url } = await store.createCheckout(id, Number(sel.value));
      window.location.href = url;
    } catch (e) {
      err.style.display = ""; err.textContent = e.message;
      btnLabel(btn, "Ouvrir le paiement");
    }
  };
}
```

- [x] **Step 4: Rebrancher l'appelant**

`index.html:6754` appelle encore `billingForm`. Remplacer :

```js
    el.onclick = e => { e.stopPropagation(); billingForm(el.dataset.billing); });
```

par :

```js
    el.onclick = e => { e.stopPropagation(); encaisserForm(el.dataset.billing); });
```

- [x] **Step 5: Retirer la consigne devenue fausse**

Dans `closeSaleForm()`, la ligne
`Ne confirmez une vente que si le client a effectué le paiement.` n'a plus
lieu d'être : l'encaissement est désormais une étape distincte et vérifiée.
La remplacer par :

```html
      <div class="alert" style="margin-bottom:16px">
        L'encaissement se fait à l'étape suivante, depuis la fiche.</div>
```

- [x] **Step 6: Contrôler la syntaxe et relancer le test**

```bash
node scratchpad/verif-syntaxe.mjs && node scratchpad/test-encaisser.mjs
```

Expected: les trois assertions passent, zéro `pageerror`.

- [x] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: collect billing day before payment and open Stripe Checkout"
```

---

## Task 11 : États de pastille pour le délai SEPA

Sans eux, une vente payée par SEPA est indiscernable d'une impayée pendant
cinq jours ouvrés.

**Files:**
- Modify: `index.html` — `pillClass` et `pillLabel` (1840-1841)

**Interfaces:**
- Consumes: `prospects.payment_status` (Task 2).

- [x] **Step 1: Écrire le test**

`scratchpad/test-pastilles.mjs` : pour chacun des cinq statuts, injecter la
valeur sur un prospect de démonstration et lire l'étiquette rendue.

```js
const libelles = await page.evaluate(() => {
  const p = { status: "conclu", paid_at: null, payment_status: null };
  const out = {};
  for (const s of ["aucun","en_cours","regle","echec","litige"]) {
    p.payment_status = s;
    p.paid_at = s === "regle" ? new Date().toISOString() : null;
    out[s] = pillLabel(p);
  }
  return out;
});
```

Attendu : `en_cours` → « Conclu · compensation en cours », `echec` →
« Paiement refusé », `litige` → « Litige en cours », `regle` → « Conclu »,
`aucun` → « Conclu · à encaisser ».

- [x] **Step 2: Lancer, vérifier l'échec**

Expected: les cinq renvoient « Conclu · à encaisser » ou « Conclu » — la
fonction ignore encore `payment_status`.

- [x] **Step 3: Étendre les deux fonctions**

Remplacer les lignes 1840-1841 par :

```js
const pillClass = p => {
  if (p.status !== "conclu") return p.status;
  if (p.payment_status === "echec" || p.payment_status === "litige") return "refuse";
  return p.paid_at ? "conclu" : "attente";
};
const pillLabel = p => {
  if (p.status !== "conclu") return statusLabel(p.status);
  if (p.payment_status === "litige")   return "Litige en cours";
  if (p.payment_status === "echec")    return "Paiement refusé";
  if (p.paid_at)                       return statusLabel("conclu");
  if (p.payment_status === "en_cours") return "Conclu · compensation en cours";
  return "Conclu · à encaisser";
};
```

L'ordre des tests compte : `paid_at` l'emporte sur `en_cours`, sinon une
vente réglée resterait affichée « en compensation » si le statut n'avait pas
été remis à jour.

- [x] **Step 4: Relancer le test**

Expected: les cinq libellés attendus, zéro `pageerror`.

- [x] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: surface SEPA settlement, failure and dispute states"
```

---

## Task 12 : Inscription, étape 4/4 — le RIB laisse place à Connect

**Files:**
- Modify: `index.html` — `signupStepHTML("paiement")` vers 3433, `signupCollect` vers 3611, validation vers 3618

**Interfaces:**
- Consumes: `store.connectOnboarding` (Task 9).

- [x] **Step 1: Écrire le test**

`scratchpad/test-inscription.mjs` :

```js
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const nav = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
});
const page = await nav.newPage();
const erreurs = [];
page.on("pageerror", (e) => erreurs.push(e.message));
await page.goto("file:///C:/Users/PC/Downloads/Norya/index.html",
                { waitUntil: "networkidle0" });

const etat = await page.evaluate(() => {
  signupData = { password: "MotDePasse1!" };
  signupStep = 3;                       // etape 4/4
  renderSignupStep();
  const btn = document.querySelector("#su_connect");
  return {
    ribPresent:    !!document.querySelector("#su_rib"),
    connectPresent: !!btn,
    connectActif:  btn ? !btn.disabled : null,
    // L'etape doit se valider sans onboarding : on ne bloque pas une
    // inscription sur une verification bancaire.
    etapeValide:   !!validateSignupStep("paiement"),
  };
});

fs.writeFileSync("scratchpad/resultat-inscription.txt", [
  `champ RIB present      : ${etat.ribPresent}      (attendu false)`,
  `bouton Connect present : ${etat.connectPresent}  (attendu true)`,
  `bouton Connect actif   : ${etat.connectActif}    (attendu true)`,
  `etape validable        : ${etat.etapeValide}     (attendu true)`,
  `erreurs de page        : ${erreurs.length} ${erreurs.join(" | ")}`,
].join("\n"));
await nav.close();
```

- [x] **Step 2: Lancer, vérifier l'échec**

```bash
node scratchpad/test-inscription.mjs && cat scratchpad/resultat-inscription.txt
```

Expected: `champ RIB present : true`, `bouton Connect present : false`,
`etape validable : false` — les trois à l'inverse de l'attendu.

- [x] **Step 3: Remplacer le contenu de l'étape**

```js
  if (key === "paiement") return `
    <div class="signup-step-title">Étape 4/4 — Paiement & sécurité</div>
    <div class="field"><label>Compte de paiement</label>
      <p style="margin:0 0 10px;color:var(--muted);font-size:12.5px">
        Vos commissions sont versées par Stripe, qui vérifie votre identité
        et collecte vos coordonnées bancaires directement. Vous pouvez le
        faire maintenant ou plus tard depuis votre espace.</p>
      <button type="button" class="ihb ihb-ghost" id="su_connect"><span class="ihb-label">Connecter mon compte de paiement</span><span class="ihb-fly"><span>Connecter mon compte de paiement</span><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></span><span class="ihb-dot" aria-hidden="true"></span></button>
      <div id="su_connect_err" class="alert err" style="display:none;margin-top:10px"></div></div>
    <div class="field"><label for="su_pass">Mot de passe</label>
      <input class="input" id="su_pass" type="password" value="${esc(signupData.password||"")}" placeholder="8 caractères minimum" autocomplete="new-password" spellcheck="false">
      ${passwordStrengthHTML()}</div>`;
```

- [x] **Step 4: Remplacer le câblage du fichier RIB par celui du bouton**

Aux lignes 3596-3603, le bloc qui câble le champ de fichier `su_rib` n'a plus
de cible. Remplacer :

```js
  if (key === "paiement"){
    const f = $("#su_rib");
    if (f) f.onchange = () => {
      signupData.ribName = f.files[0]?.name || null;
      const lbl = $("#su_rib_label");
      if (lbl) lbl.textContent = signupData.ribName || "Choisir un fichier (PDF, JPG, PNG)";
    };
  }
```

par :

```js
  if (key === "paiement"){
    const b = $("#su_connect");
    if (b) b.onclick = async () => {
      const err = $("#su_connect_err");
      err.style.display = "none";
      btnLabel(b, "Ouverture…");
      try {
        const { url } = await store.connectOnboarding();
        window.location.href = url;
      } catch (e) {
        err.style.display = ""; err.textContent = e.message;
        btnLabel(b, "Connecter mon compte de paiement");
      }
    };
  }
```

`collectSignupStep` (ligne 3611) ne lisait déjà que le mot de passe : rien à
y changer.

- [x] **Step 5: Retirer le RIB de la validation**

Ligne 3618, remplacer :

```js
  if (key === "paiement") return signupData.ribName && signupData.password && signupData.password.length >= 8;
```

par :

```js
  if (key === "paiement") return signupData.password && signupData.password.length >= 8;
```

L'onboarding Stripe ne conditionne pas la validation de l'étape : un
commercial s'inscrit, vend, et sa commission attend sa vérification.

- [x] **Step 6: Contrôler la syntaxe et relancer le test**

```bash
node scratchpad/verif-syntaxe.mjs
node scratchpad/test-inscription.mjs && cat scratchpad/resultat-inscription.txt
```

Expected: `false / true / true / true` dans l'ordre du rapport, et zéro
erreur de page.

- [x] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: replace RIB upload with Stripe Connect onboarding"
```

---

## Task 13 : Bandeau d'état Stripe dans l'espace commercial

Un état, formulé à la deuxième personne. Jamais une erreur, jamais un blocage.

**Files:**
- Modify: `index.html` — vue tableau de bord commercial vers 5109

**Interfaces:**
- Consumes: `profiles.stripe_account_id`, `profiles.stripe_payouts_enabled` (Task 2) ; `store.connectOnboarding` (Task 9).

- [x] **Step 1: Écrire le test**

`scratchpad/test-bandeau-stripe.mjs` :

```js
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const nav = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
});
const page = await nav.newPage();
const erreurs = [];
page.on("pageerror", (e) => erreurs.push(e.message));
await page.goto("file:///C:/Users/PC/Downloads/Norya/index.html",
                { waitUntil: "networkidle0" });

const cas = await page.evaluate(() => {
  const rendre = (me) => {
    const d = document.createElement("div");
    d.innerHTML = bandeauStripe(me);
    const b = d.querySelector("#stripeConnect");
    return {
      texte:    d.textContent.replace(/\s+/g, " ").trim(),
      bouton:   !!b,
      disabled: b ? b.disabled : null,
    };
  };
  return {
    aucun:    rendre({ stripe_account_id: null,     stripe_payouts_enabled: false }),
    enCours:  rendre({ stripe_account_id: "acct_1", stripe_payouts_enabled: false }),
    actif:    rendre({ stripe_account_id: "acct_1", stripe_payouts_enabled: true  }),
  };
});

fs.writeFileSync("scratchpad/resultat-bandeau.txt", [
  `aucun compte  : bouton=${cas.aucun.bouton} disabled=${cas.aucun.disabled}`,
  `  texte       : ${cas.aucun.texte}`,
  `en cours      : bouton=${cas.enCours.bouton} disabled=${cas.enCours.disabled}`,
  `  texte       : ${cas.enCours.texte}`,
  `actif         : texte vide = ${cas.actif.texte === ""}`,
  `erreurs       : ${erreurs.length} ${erreurs.join(" | ")}`,
].join("\n"));
await nav.close();
```

Attendu : « aucun compte » mentionne « Vous n'avez pas encore connecté »,
« en cours » mentionne « en cours de vérification », « actif » ne rend rien
du tout, et `disabled` vaut `false` dans les deux premiers cas — l'état se
dit avec des mots, jamais avec un bouton grisé.

- [x] **Step 2: Lancer, vérifier l'échec**

```bash
node scratchpad/test-bandeau-stripe.mjs && cat scratchpad/resultat-bandeau.txt
```

Expected: `bandeauStripe is not defined` dans les erreurs de page.

- [x] **Step 3: Ajouter le bandeau**

```js
/* État du compte de paiement du commercial. Trois états, aucun blocage :
   il vend normalement, la commission suit. */
function bandeauStripe(me){
  if (me.stripe_payouts_enabled) return "";
  const enCours = !!me.stripe_account_id;
  return `
    <div class="alert ${enCours ? "" : "warn"}" style="margin-bottom:14px">
      <b>${enCours
        ? "Votre compte de paiement est en cours de vérification."
        : "Vous n'avez pas encore connecté de compte de paiement."}</b><br>
      ${enCours
        ? "Vos commissions sont mises de côté et vous seront versées automatiquement dès que Stripe aura terminé."
        : "Vous pouvez vendre dès maintenant : vos commissions vous attendront."}
      <div style="margin-top:10px">
        <button class="ihb ihb-ghost" id="stripeConnect"><span class="ihb-label">${enCours ? "Reprendre la vérification" : "Connecter mon compte"}</span><span class="ihb-fly"><span>${enCours ? "Reprendre la vérification" : "Connecter mon compte"}</span><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></span><span class="ihb-dot" aria-hidden="true"></span></button>
      </div>
    </div>`;
}
```

Et le câblage, dans la fonction de rendu de la vue :

```js
  const b = document.querySelector("#stripeConnect");
  if (b) b.onclick = async () => {
    btnLabel(b, "Ouverture…");
    try { const { url } = await store.connectOnboarding(); window.location.href = url; }
    catch (e) { toast(e.message, "err"); btnLabel(b, "Connecter mon compte"); }
  };
```

- [x] **Step 4: Relancer le test**

Expected: les trois états rendent le bon texte, aucun bouton `disabled`.

- [x] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: show Stripe account status to commercials as a state"
```

---

## Task 14 : CA annuel et jauge de seuil dans l'espace admin

**Files:**
- Modify: `index.html` — vue administrateur

**Interfaces:**
- Consumes: `store.caAnnuel` (Task 9), vue `ca_annuel` (Task 3).

- [x] **Step 1: Écrire le test**

Trois scénarios de `ca_cents` — 10 %, 85 %, 105 % du seuil — et vérifier que
l'alerte n'apparaît qu'à partir de 80 %, et que la mention « règle à
confirmer » est présente tant que `regle_confirmee` est faux.

- [x] **Step 2: Lancer, vérifier l'échec**

Expected: `carteCA is not defined`.

- [x] **Step 3: Ajouter la carte**

```js
/* CA encaissé de l'année face au seuil de franchise de TVA.
   L'alerte se déclenche à 80 % : assez tôt pour arbitrer. */
function carteCA(ca){
  if (!ca) return "";
  const pct    = Math.min(100, Math.round(ca.ca_cents / ca.seuil_franchise_cents * 100));
  const alerte = ca.ca_cents >= ca.seuil_franchise_cents * 0.8;
  const reste  = Math.max(0, ca.seuil_franchise_cents - ca.ca_cents);
  return `
    <div class="card">
      <div class="card-title">Chiffre d'affaires ${ca.annee}</div>
      <div class="num" style="font-size:26px">${eur(ca.ca_cents / 100)}</div>
      <div style="height:6px;background:var(--surface-3);border-radius:var(--r-sm);overflow:hidden;margin:10px 0 6px">
        <div style="height:100%;width:${pct}%;background:${alerte ? "var(--amber)" : "var(--accent)"}"></div>
      </div>
      <small style="color:var(--muted)">
        ${pct} % du seuil de franchise de TVA (${eur(ca.seuil_franchise_cents / 100)})
        ${reste ? ` · il reste ${eur(reste / 100)}` : " · seuil atteint"}</small>
      ${alerte ? `<div class="alert warn" style="margin-top:10px">
        Au-delà de ${eur(ca.seuil_tolerance_cents / 100)}, la TVA s'applique
        à la date du dépassement. Anticipez la bascule.</div>` : ""}
      ${ca.regle_confirmee ? "" : `<small style="display:block;margin-top:10px;color:var(--muted)">
        Calcul sur le ${ca.ca_base === "brut_encaisse" ? "brut encaissé" : "net après commission"} —
        règle non encore confirmée auprès d'un comptable.</small>`}
    </div>`;
}
```

La dernière ligne est la réserve du propriétaire rendue visible : tant que
`regle_confirmee` est faux, l'administrateur voit le chiffre **et** le fait
qu'il repose sur une interprétation.

- [x] **Step 4: Relancer le test**

Expected: pas d'alerte à 10 %, alerte à 85 % et 105 %, mention de réserve
présente dans les trois cas.

- [x] **Step 5: Ajouter le journal des transferts de commission**

Dans `store` (réel), après `caAnnuel` :

```js
  async transferts(){
    const { data, error } = await sb.from("commission_transfers")
      .select("*, profiles(full_name)")
      .order("created_at", { ascending:false }).limit(100);
    if (error) throw error; return data;
  },
```

Dans `demoStore` : `async transferts(){ return []; },`

Et la table, dans la vue administrateur :

```js
/* Journal des commissions versées. « en attente » n'est pas une panne :
   c'est le temps que met Stripe à vérifier un compte. */
function tableTransferts(lignes){
  if (!lignes.length) return `<p style="color:var(--muted)">Aucune commission versée pour l'instant.</p>`;
  const etat = {
    verse: "Versée",
    en_attente_onboarding: "En attente de vérification",
    echec: "Échec"
  };
  return `
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Commercial</th><th>Montant</th><th>État</th><th class="opt-md">Date</th></tr></thead>
      <tbody>${lignes.map(l => `
        <tr>
          <td>${esc(l.profiles?.full_name || "—")}</td>
          <td class="num">${eur(l.amount_cents / 100)}</td>
          <td><span class="pill ${l.status === "verse" ? "conclu" : l.status === "echec" ? "refuse" : "attente"}">${etat[l.status] || l.status}</span></td>
          <td class="opt-md">${new Date(l.created_at).toLocaleDateString("fr-FR")}</td>
        </tr>`).join("")}
      </tbody>
    </table></div>`;
}
```

Le `.tbl-wrap` est obligatoire : il porte l'`overflow-x:auto` qui laisse la
table déborder dans son cadre scrollable au lieu de faire défiler la page.

- [x] **Step 6: Vérifier le rendu du journal**

Étendre `scratchpad/test-ca-admin.mjs` : appeler `tableTransferts` avec les
trois statuts et vérifier que chaque ligne rend le libellé français attendu
et que le conteneur porte bien la classe `tbl-wrap`.

Expected: « Versée », « En attente de vérification », « Échec », et
`document.querySelector(".tbl-wrap")` non nul.

- [x] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: track yearly revenue and list commission transfers"
```

---

## Task 15 : Campagne de bout en bout en mode test

Rien n'est irréversible ici : le mode test de Stripe ne déplace pas d'argent.

**Files:** aucun (vérification)

### Résultats au 16/09/2026

**Fonctions vérifiées en réel, 17/17.** `create-checkout` rend une vraie URL
`cs_test_…` — le préfixe confirme au passage que la clé posée est bien de
test. La fiche passe à `en_cours` avec son jour de prélèvement et son client
Stripe, `paid_at` reste vide. Les refus mordent : `409` sur une vente déjà
encaissée, `403` sur une fiche attribuée à un autre, `422` sur un jour hors
plage. `connect-onboarding` rend un lien réel et ne crée pas de second compte
quand on le rappelle.

**Points d'entrée déployés, 10/10** sur trois passes : refus sans jeton, refus
de la clé anonyme, refus du webhook sans signature et sur signature invalide.

**Site en ligne, 9/9** : mode démonstration actif, garde d'essai tenue, neuf
vues sans débordement en 1440 px et cinq en 375 px, zéro erreur de page.

**Webhook, 6/6** contre la vraie base (tâche 8) : signature, effet, idempotence.

### Trois obstacles rencontrés, et ce qu'ils ont changé

**Accounts v1 refusé.** Stripe ne crée plus de compte Connect en v1 pour une
intégration neuve. Migration en v2, configuration `recipient` seule, frais et
pertes à la charge de la plateforme. SDK porté en 22.6.2.

**`No such price`.** La clé secrète et les prix vivaient dans deux comptes
Stripe distincts. Les identifiants de prix ont disparu des secrets : ils se
résolvent désormais par clé de recherche dans le compte de la clé, ce qui rend
le décalage impossible au lieu de rare.

**`proration_behavior` refusé.** Stripe l'interdit dès qu'une session porte un
prix ponctuel. Remplaé par `trial_end` jusqu'au jour choisi, ce qui donne
exactement ce que la modale promet plutôt qu'un prorata non annoncé.

### Paiement réel vérifié — 17/17

Un vrai paiement de test par carte a traversé toute la chaîne :

```
paid_at écrit par le webhook   2026-09-16T06:11:43
statut                          regle
encaissement                    site · 80000 · paye · in_1UGC4E…
commission                      32000 · en_attente_onboarding
CA de l'année                   80000
```

Le second verrou contre un double versement est prouvé lui aussi : une
seconde ligne de commission sur le même encaissement est refusée par
`commission_transfers_payment_unique`.

**Le premier paiement de test a révélé un bug grave** : `invoice.paid`
n'a rien fait du tout, en répondant 200. Stripe a déplacé
`invoice.subscription_details` sous `invoice.parent.subscription_details`
avec l'API 2025 ; la lecture revenait vide et les gardes « pas de fiche,
on ne fait rien » ont avalé un encaissement de 800 € en silence. Corrigé
en deux temps : résolution de la fiche côté serveur avec repli sur le
client Stripe, et une facture non rattachable lève désormais au lieu de
se taire.

### Ce qui reste, et pourquoi — état au 16/09/2026

Aucun des points restants n'est exécutable par un agent. Ce n'est pas une
limite d'outillage mais de nature : chacun exige soit la saisie d'une
coordonnée bancaire, soit une vérification d'identité, soit la bascule en
production que le propriétaire a explicitement exclue.

| Point | Ce qui manque |
|---|---|
| Étapes 4 et 5 — SEPA | un IBAN saisi dans le formulaire Stripe. Test : `FR1420041010050500013M02606` se compense, `…M02607` échoue |
| Étape 6, seconde moitié | la vérification d'identité du commercial, qui déclenche `account.updated` puis le rejeu de la file |
| Étape 8 — ancre | l'inspection de l'abonnement Stripe : le CLI et la clé secrète ne sont pas sur le même compte. Couverte par huit tests unitaires, changements d'heure compris |
| Étape 9 — mention 293 B | un accès authentifié au tableau de bord Stripe |
| Tâche 16 — production | exclue par consigne : `DEMO` reste à `true` et Stripe en mode test |

### Nettoyage effectué

Le jeu d'essai est supprimé : plus aucun prospect, encaissement, commission ni
compte de test en base. Seul le profil réel `zel.zx35@gmail.com` subsiste.

Les trois lignes de `stripe_events` sont **conservées volontairement** : elles
empêchent le retraitement d'événements de test dont la fiche n'existe plus, qui
lèverait désormais — comportement voulu, mais bruit inutile.

Restent à annuler côté Stripe, en mode test, faute d'accès à ce compte :

```
sub_1UGBh2V05KpDxKCv…        abonnement du premier essai
sub_1UGC4GV05KpDxKCv5wnO18SA  abonnement du second essai
acct_1UGBYyV05KrGGmso         compte Connect du commercial d'essai
acct_1UGBTUV05KnvYq7a         compte Connect créé pendant un diagnostic
acct_1UGBXLV05KJO63rW         idem
cus_VGidOcMwlZ2JXd            client d'un diagnostic interrompu
```

Pour refaire un jeu d'essai en une commande :
`node scratchpad/fixture.mjs`

- [x] **Step 1: Poser les secrets**

Trois valeurs sur cinq sont posées. Les deux restantes sont à fournir par le
propriétaire du compte Stripe :

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_...
```

Le secret de webhook s'obtient en enregistrant le point d'entrée
`https://olirdsbyvxjlysdylrmr.supabase.co/functions/v1/stripe-webhook`
dans le tableau de bord Stripe, en mode test, sur les événements
`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
`charge.dispute.created` et `account.updated`.

- [x] **Step 2: Déployer les trois fonctions**

```bash
supabase functions deploy create-checkout
supabase functions deploy connect-onboarding
supabase functions deploy stripe-webhook --no-verify-jwt
```

- [x] **Step 3: Carte qui passe**

Payer avec `4242 4242 4242 4242`, date future, CVC quelconque.
Attendu : `paid_at` écrit, `payment_status = 'regle'`, une ligne
`payments` de `80000`, un `commission_transfers` de `32000` en `verse`.

- [ ] **Step 4: SEPA qui se compense**

IBAN de test `FR1420041010050500013M02606`.
Attendu : la fiche reste « Conclu · compensation en cours », puis bascule
après l'événement `invoice.paid` déclenché par Stripe.

- [ ] **Step 5: SEPA qui échoue**

IBAN d'échec `FR1420041010050500013M02607`.
Attendu : `payment_status = 'echec'`, pastille « Paiement refusé »,
**aucune** ligne dans `commission_transfers`.

- [ ] **Step 6: Commercial non vérifié**

Vendre depuis un compte sans onboarding terminé.
Attendu : `commission_transfers.status = 'en_attente_onboarding'`. Puis
terminer l'onboarding et vérifier que le statut passe à `verse` sans
intervention.

- [x] **Step 7: Rejeu**

```bash
stripe events resend <evt_id_de_invoice.paid>
psql "$DB_URL" -c "select count(*) from commission_transfers;"
```

Expected: le compte n'augmente pas.

- [ ] **Step 8: Ancre de facturation**

Vérifier dans le tableau de bord Stripe que la date de la prochaine facture
de l'abonnement correspond exactement à celle qu'affichait `nextBilling()`
dans la modale.

- [x] **Step 9: Garde démonstration en ligne**

Sur `https://norya.zx-zelph.workers.dev`, ouvrir un profil d'essai, tenter d'encaisser.
Attendu : « Les paiements sont désactivés dans le profil d'essai », et
**zéro** requête vers `/functions/v1/` dans l'onglet réseau.

- [x] **Step 10: Consigner les résultats**

```bash
git commit --allow-empty -m "test: end-to-end payment flow verified in Stripe test mode"
```

---

## Task 16 : Checklist de bascule en production

**À ne pas exécuter** tant que les points ci-dessous ne sont pas tous vrais.
Cette tâche documente la bascule, elle ne la fait pas. Aucune case ne doit
être cochée par un agent : chacune engage de l'argent réel.

### État constaté au 16/09/2026

| Point | État |
|---|---|
| Compte bancaire rattaché | **non** — pas encore de compte pro ouvert |
| Connect activé | **à vérifier** — jamais appelé en réel faute de clé secrète |
| Règle fiscale confirmée | **non** — `fiscal_config.regle_confirmee = false` |
| Mention 293 B en pied de facture | **à vérifier** dans le tableau de bord |
| Prix en mode live | **non** — seuls les prix de test existent |
| Clés live posées | **non** — même les clés de test ne sont pas posées |
| Webhook live enregistré | **non** |
| `DEMO = false` | **non**, et c'est voulu |
| Vente réelle vérifiée | **non** |

Rien n'est prêt pour la production, et rien ne doit l'être tant que le compte
bancaire n'existe pas : sans IBAN, Stripe encaisserait sans pouvoir reverser,
et les commissions des commerciaux resteraient bloquées chez la plateforme.

- [ ] Un compte bancaire au nom de l'entreprise individuelle est rattaché à
      Stripe. Sans lui, Stripe encaisse mais retient les fonds.
- [ ] Connect est activé sur le compte Stripe, avec les mentions légales de
      la plateforme renseignées.
- [ ] La règle fiscale (§7 de la spec) est confirmée, et
      `fiscal_config.regle_confirmee` passe à `true` — ou `ca_base` est
      corrigée s'il s'avère que la lecture retenue n'était pas la bonne.
- [ ] Le pied de facture Stripe porte « TVA non applicable, art. 293 B du CGI ».
- [ ] Les produits et prix sont recréés en mode live ; `PRICE_SITE` et
      `PRICE_MAINTENANCE` pointent sur les identifiants live.
- [ ] `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET` sont les clés live.
- [ ] Le point d'entrée webhook live est enregistré sur l'URL de production.
- [ ] `DEMO` passe à `false` dans `index.html`, et le déploiement Cloudflare
      est refait.
- [ ] Une vente réelle de bout en bout est faite et vérifiée, de préférence
      sur un client complice.

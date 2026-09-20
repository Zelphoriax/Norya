/**
 * Les `Price` Stripe de Norya, résolus par clé de recherche.
 *
 * Pourquoi pas des identifiants dans les secrets : un `price_...` n'existe que
 * dans le compte Stripe où il a été créé. Coller à la main un identifiant issu
 * d'un compte et une clé secrète issue d'un autre donne un « No such price »
 * qui ne dit surtout pas que le problème est un compte différent. L'erreur
 * s'est produite ici même. Une clé de recherche se résout dans le compte de la
 * clé secrète, quel qu'il soit : le décalage devient impossible plutôt que
 * rare — et avec trois paliers, il y aurait eu trois fois plus d'occasions de
 * se tromper.
 *
 * Les montants viennent de config.ts, seule source de vérité.
 */

import { stripe } from "./stripe.ts";
import {
  MONTANT_MAINTENANCE_CENTS,
  PALIERS_SITE_CENTS,
  palierValide,
} from "./config.ts";

const cleSite = (cents: number) => `norya_site_${cents}_v1`;
const CLE_MAINTENANCE = "norya_maintenance_v1";

const cache = new Map<string, string>();

async function resoudre(
  lookupKey: string,
  montantCents: number,
  nom: string,
  mensuel: boolean,
): Promise<string> {
  const connu = cache.get(lookupKey);
  if (connu) return connu;

  const existants = await stripe.prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });
  const trouve = existants.data[0];

  if (trouve) {
    // Un prix dont le montant ne correspond plus au barème signalerait une
    // divergence entre le code et Stripe : on préfère le dire.
    if (trouve.unit_amount !== montantCents) {
      throw new Error(
        `Le prix ${lookupKey} vaut ${trouve.unit_amount} centimes chez Stripe ` +
          `alors que le barème en attend ${montantCents}.`,
      );
    }
    cache.set(lookupKey, trouve.id);
    return trouve.id;
  }

  const cree = await stripe.prices.create({
    currency: "eur",
    unit_amount: montantCents,
    lookup_key: lookupKey,
    ...(mensuel ? { recurring: { interval: "month" } } : {}),
    product_data: { name: nom },
  });
  cache.set(lookupKey, cree.id);
  return cree.id;
}

/** Prix du site pour un palier. Le palier doit avoir été validé en amont. */
export function prixSite(montantCents: number): Promise<string> {
  if (!palierValide(montantCents)) {
    throw new Error(
      `Montant ${montantCents} hors barème. Paliers : ${PALIERS_SITE_CENTS.join(", ")}.`,
    );
  }
  return resoudre(
    cleSite(montantCents),
    montantCents,
    `Site internet — ${montantCents / 100} €`,
    false,
  );
}

/** Prix de la maintenance mensuelle, identique pour tous les paliers. */
export function prixMaintenance(): Promise<string> {
  return resoudre(
    CLE_MAINTENANCE,
    MONTANT_MAINTENANCE_CENTS,
    "Maintenance Norya",
    true,
  );
}

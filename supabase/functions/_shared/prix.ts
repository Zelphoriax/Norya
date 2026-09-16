/**
 * Les deux `Price` Stripe de Norya, résolus par clé de recherche.
 *
 * Pourquoi pas deux identifiants dans les secrets : un `price_...` n'existe
 * que dans le compte Stripe où il a été créé. Coller à la main un identifiant
 * issu d'un compte et une clé secrète issue d'un autre donne un
 * « No such price » qui ne dit surtout pas que le problème est un compte
 * différent. L'erreur s'est produite ici même. Une clé de recherche, elle,
 * se résout dans le compte de la clé secrète, quel qu'il soit : le décalage
 * devient impossible plutôt que simplement rare.
 *
 * Les montants viennent de config.ts, seule source de vérité — le webhook
 * comptabilise déjà la vente sur cette constante plutôt que sur le total
 * facturé.
 */

import { stripe } from "./stripe.ts";
import { MONTANT_MAINTENANCE_CENTS, MONTANT_SITE_CENTS } from "./config.ts";

const CLE_SITE = "norya_site_v1";
const CLE_MAINTENANCE = "norya_maintenance_v1";

type Prix = { site: string; maintenance: string };
let cache: Prix | null = null;

async function resoudre(
  lookupKey: string,
  montantCents: number,
  nom: string,
  mensuel: boolean,
): Promise<string> {
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
    return trouve.id;
  }

  const cree = await stripe.prices.create({
    currency: "eur",
    unit_amount: montantCents,
    lookup_key: lookupKey,
    ...(mensuel ? { recurring: { interval: "month" } } : {}),
    product_data: { name: nom },
  });
  return cree.id;
}

/** Résout les deux prix, une seule fois par instance de fonction. */
export async function prix(): Promise<Prix> {
  if (cache) return cache;
  cache = {
    site: await resoudre(CLE_SITE, MONTANT_SITE_CENTS, "Site internet", false),
    maintenance: await resoudre(
      CLE_MAINTENANCE,
      MONTANT_MAINTENANCE_CENTS,
      "Maintenance Norya",
      true,
    ),
  };
  return cache;
}

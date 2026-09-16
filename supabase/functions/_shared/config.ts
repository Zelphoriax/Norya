/**
 * Barème Norya, côté serveur.
 *
 * Ces montants ne viennent jamais de la requête du navigateur : un client qui
 * choisirait lui-même le prix de son site, ou le montant de la commission,
 * n'aurait qu'à modifier le corps de l'appel. Ils sont fixés ici, et dans les
 * objets `Price` de Stripe — les deux doivent rester d'accord.
 *
 * En centimes entiers : jamais de flottant sur de l'argent.
 */

export const MONTANT_SITE_CENTS = 80_000;
export const MONTANT_MAINTENANCE_CENTS = 4_900;
export const COMMISSION_CENTS = 32_000;

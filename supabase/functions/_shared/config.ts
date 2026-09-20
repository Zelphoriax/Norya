/**
 * Barème Norya, côté serveur.
 *
 * Ces montants ne viennent jamais de la requête du navigateur : un client qui
 * choisirait lui-même le prix de son site n'aurait qu'à modifier le corps de
 * l'appel. Le navigateur propose un palier ; le serveur vérifie qu'il fait
 * partie de la liste, et c'est cette liste qui fait foi.
 *
 * En centimes entiers : jamais de flottant sur de l'argent.
 */

/** Les trois formules de site. Tout autre montant est refusé. */
export const PALIERS_SITE_CENTS = [35_000, 50_000, 80_000];

/** Maintenance mensuelle, identique quel que soit le palier. */
export const MONTANT_MAINTENANCE_CENTS = 4_900;

/** Part du commercial sur la vente du site, en pourcentage. */
export const TAUX_COMMISSION = 40;

/** Palier retenu par défaut, et pour les ventes antérieures aux paliers. */
export const MONTANT_SITE_DEFAUT_CENTS = 80_000;

export function palierValide(montantCents: unknown): montantCents is number {
  return typeof montantCents === "number" &&
    PALIERS_SITE_CENTS.includes(montantCents);
}

/**
 * Commission due sur une vente. Elle suit le palier : 140 € sur 350,
 * 200 € sur 500, 320 € sur 800. La maintenance ne commissionne pas.
 */
export function commissionCents(montantSiteCents: number): number {
  return Math.round(montantSiteCents * TAUX_COMMISSION / 100);
}

/**
 * Mention obligatoire en franchise en base de TVA.
 *
 * Elle est posée sur le client Stripe (`invoice_settings.footer`), et non sur
 * le compte : `settings.invoices.default_footer` n'existe pas — l'API accepte
 * l'appel sans rien enregistrer, ce qui est pire qu'un refus. Le champ client
 * s'applique à toutes ses factures, la première comme les mensualités.
 */
export const MENTION_TVA = "TVA non applicable, art. 293 B du CGI";

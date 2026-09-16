/**
 * Ancre de facturation Stripe : l'instant du prochain prélèvement mensuel.
 *
 * Le raisonnement se fait en heure civile de Paris, jamais en UTC. `nextBilling()`
 * dans index.html construit sa date avec `new Date(annee, mois, jour)`, donc à
 * minuit **local**. Calculer l'ancre en UTC ferait diverger les deux entre
 * minuit et 2 h du matin le jour du prélèvement : l'interface annoncerait le 20
 * septembre pendant que Stripe facturerait le 20 octobre.
 *
 * Paris et non le fuseau du navigateur : le serveur ne connaît pas celui du
 * commercial, et l'entreprise, ses clients et son compte Stripe sont français.
 */

const FUSEAU = "Europe/Paris";

type Civil = {
  annee: number; mois: number; jour: number;
  heure: number; minute: number; seconde: number;
};

/** Décomposition d'un instant en date et heure civiles parisiennes. */
function civilParis(instant: Date): Civil {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSEAU,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(instant);

  const v: Record<string, string> = {};
  for (const p of parts) v[p.type] = p.value;

  return {
    annee: Number(v.year), mois: Number(v.month), jour: Number(v.day),
    // Certaines implémentations rendent minuit comme « 24 ».
    heure: Number(v.hour) % 24,
    minute: Number(v.minute), seconde: Number(v.second),
  };
}

/** Écart Paris - UTC, en millisecondes, à l'instant donné. */
function decalage(instant: Date): number {
  const c = civilParis(instant);
  const commeSiUTC = Date.UTC(c.annee, c.mois - 1, c.jour, c.heure, c.minute, c.seconde);
  return commeSiUTC - instant.getTime();
}

/**
 * Instant UTC correspondant à minuit, heure de Paris, pour une date civile.
 *
 * Deux passes : la première estime le décalage à partir de la date visée lue
 * comme si elle était UTC, la seconde le corrige quand cette estimation tombe
 * du mauvais côté d'un changement d'heure. Au-delà, le résultat est stable.
 */
function minuitParis(annee: number, mois: number, jour: number): number {
  const vise = Date.UTC(annee, mois - 1, jour, 0, 0, 0);
  let t = vise - decalage(new Date(vise));
  t = vise - decalage(new Date(t));
  return t;
}

/**
 * Horodatage Stripe, en secondes, du prochain prélèvement au jour donné.
 *
 * Le jour même, on bascule au mois suivant : minuit est déjà passé, exactement
 * comme le fait `nextBilling()`. Le jour est limité à 28 pour que la date
 * existe tous les mois, février compris.
 */
export function ancreFacturation(jour: number, maintenant: Date): number {
  if (!Number.isInteger(jour) || jour < 1 || jour > 28) {
    throw new Error("Le jour de prélèvement doit être un entier entre 1 et 28.");
  }

  const ici = civilParis(maintenant);
  let annee = ici.annee;
  let mois = ici.mois;

  let t = minuitParis(annee, mois, jour);
  if (t <= maintenant.getTime()) {
    mois += 1;
    if (mois > 12) { mois = 1; annee += 1; }
    t = minuitParis(annee, mois, jour);
  }

  return Math.floor(t / 1000);
}

import Stripe from "npm:stripe@22.6.2";

/**
 * Client Stripe pour Deno.
 *
 * `createFetchHttpClient` est obligatoire : le client HTTP par défaut du SDK
 * suppose les modules Node, absents ici. C'est aussi lui qui rend possible
 * `webhooks.constructEventAsync`, la seule variante de vérification de
 * signature utilisable sans crypto synchrone.
 *
 * La version d'API n'est pas fixée à la main : le SDK est épinglé et porte la
 * sienne. Donner une chaîne qui ne correspond pas à celle du SDK échoue au
 * démarrage.
 *
 * Le repli sur une clé factice n'est pas de la complaisance. Sans lui,
 * `new Stripe("")` lève à l'import et la fonction entière refuse de démarrer :
 * un secret oublié se manifeste alors par un WORKER_ERROR opaque, y compris
 * sur les chemins qui n'ont aucun besoin de Stripe — un appel sans jeton
 * d'authentification, ou un webhook non signé. Avec ce repli, ces chemins
 * répondent correctement, la vérification de signature continue de
 * fonctionner (c'est un HMAC, pas un appel d'API), et seul un vrai appel à
 * Stripe échoue, en le disant.
 */

const CLE = Deno.env.get("STRIPE_SECRET_KEY");

/** Vrai quand la fonction peut réellement parler à Stripe. */
export const stripeConfigure = Boolean(CLE);

export const stripe = new Stripe(CLE ?? "sk_test_absente", {
  httpClient: Stripe.createFetchHttpClient(),
});

/** Message unique quand le secret manque, pour ne pas le dire deux façons. */
export const STRIPE_ABSENT =
  "Le service de paiement n'est pas configuré : STRIPE_SECRET_KEY manque côté serveur.";

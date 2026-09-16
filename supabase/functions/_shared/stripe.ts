import Stripe from "npm:stripe@17.7.0";

/**
 * Client Stripe pour Deno.
 *
 * `createFetchHttpClient` est obligatoire : le client HTTP par défaut du SDK
 * suppose les modules Node, absents ici. C'est aussi lui qui rend possible
 * `webhooks.constructEventAsync`, la seule variante de vérification de
 * signature utilisable sans crypto synchrone.
 *
 * La version d'API n'est pas fixée à la main : le SDK est épinglé, et il porte
 * la sienne. Donner une chaîne qui ne correspond pas à celle du SDK échoue au
 * démarrage.
 */
export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});

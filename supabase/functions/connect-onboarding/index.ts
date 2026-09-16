/**
 * Ouvre l'onboarding Stripe Connect d'un commercial.
 *
 * C'est Stripe qui vérifie son identité et recueille ses coordonnées
 * bancaires : Norya ne les voit jamais et n'en garde rien, seulement
 * l'identifiant du compte lié.
 *
 * Accounts v2, et non v1 : Stripe refuse désormais `POST /v1/accounts` pour
 * une intégration neuve — « Stripe no longer recommends Accounts v1 for new
 * Connect integrations ». On pourrait réactiver v1 par un réglage du tableau
 * de bord, mais ce serait s'endetter dès le premier jour sur un chemin que
 * Stripe déconseille.
 *
 * Configuration `recipient` seule : le commercial reçoit des virements sur son
 * solde Stripe, il n'encaisse jamais le client lui-même. Lui accorder
 * `merchant` lui donnerait le droit de facturer en son nom, ce qu'on ne veut
 * pas — c'est Norya qui vend.
 *
 * Idempotent : rappelée, la fonction ne crée pas un second compte, elle
 * renvoie un nouveau lien vers le même. Un lien d'onboarding expire vite, donc
 * un commercial qui reprend la démarche plus tard en obtient simplement un neuf.
 */

import { stripe, stripeConfigure, STRIPE_ABSENT } from "../_shared/stripe.ts";
import { db } from "../_shared/db.ts";
import { reponse, CORS } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reponse({ error: "Méthode non autorisée." }, 405);

  const jeton = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jeton) return reponse({ error: "Authentification requise." }, 401);

  const sb = db();
  const { data: { user }, error: errAuth } = await sb.auth.getUser(jeton);
  if (errAuth || !user) return reponse({ error: "Session invalide." }, 401);

  const { data: profil } = await sb
    .from("profiles")
    .select("id, email, full_name, stripe_account_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profil) return reponse({ error: "Profil introuvable." }, 404);

  // Un secret oublié doit se dire, pas se manifester par une panne.
  if (!stripeConfigure) return reponse({ error: STRIPE_ABSENT }, 503);

  try {
    let compte = profil.stripe_account_id;
    if (!compte) {
      const c = await stripe.v2.core.accounts.create({
        contact_email: profil.email ?? undefined,
        display_name: profil.full_name ?? undefined,
        identity: { country: "fr", entity_type: "individual" },
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: {
                // Recevoir les virements de commission sur son solde Stripe.
                // Le reversement vers sa banque se règle ensuite dans son
                // tableau de bord Express : ce n'est pas à demander ici.
                stripe_transfers: { requested: true },
              },
            },
          },
        },
        // Qui porte les frais et les pertes. Les deux reviennent à Norya :
        // c'est elle qui vend, elle qui encaisse le client, et le commercial
        // ne reçoit qu'une commission. Lui faire porter les frais Stripe
        // rognerait ses 320 €, et lui faire porter un impayé lui ferait payer
        // un défaut de paiement d'un client qui n'est pas le sien.
        defaults: {
          responsibilities: {
            fees_collector: "application",
            losses_collector: "application",
          },
        },
        // Stripe héberge le tableau de bord du commercial : Norya n'a pas à
        // reconstruire un espace de suivi des virements.
        dashboard: "express",
        metadata: { profile_id: profil.id },
      });
      compte = c.id;
      await sb.from("profiles").update({ stripe_account_id: compte }).eq("id", profil.id);
    }

    const racine = Deno.env.get("NORYA_URL") ?? "";
    const lien = await stripe.v2.core.accountLinks.create({
      account: compte,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["recipient"],
          refresh_url: `${racine}/?stripe=reprendre`,
          return_url: `${racine}/?stripe=termine`,
        },
      },
    });

    return reponse({ url: lien.url });
  } catch (e) {
    console.error("connect-onboarding :", e);
    return reponse({ error: `Stripe a refusé la demande : ${(e as Error).message}` }, 502);
  }
});

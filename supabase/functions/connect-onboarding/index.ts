/**
 * Ouvre l'onboarding Stripe Connect Express d'un commercial.
 *
 * C'est Stripe qui vérifie son identité et recueille ses coordonnées
 * bancaires : Norya ne les voit jamais et n'en garde rien, seulement
 * l'identifiant du compte lié.
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
      const c = await stripe.accounts.create({
        type: "express",
        country: "FR",
        email: profil.email ?? undefined,
        business_type: "individual",
        // Seuls les virements sont demandés : le commercial reçoit sa
        // commission, il n'encaisse jamais lui-même le client.
        capabilities: { transfers: { requested: true } },
        metadata: { profile_id: profil.id },
      });
      compte = c.id;
      await sb.from("profiles").update({ stripe_account_id: compte }).eq("id", profil.id);
    }

    const racine = Deno.env.get("NORYA_URL") ?? "";
    const lien = await stripe.accountLinks.create({
      account: compte,
      type: "account_onboarding",
      refresh_url: `${racine}/?stripe=reprendre`,
      return_url: `${racine}/?stripe=termine`,
    });

    return reponse({ url: lien.url });
  } catch (e) {
    console.error("connect-onboarding :", e);
    return reponse({ error: `Stripe a refusé la demande : ${(e as Error).message}` }, 502);
  }
});

/**
 * Ouvre une session de paiement Stripe pour une vente.
 *
 * Une seule session encaisse les 800 € du site et arme les 49 €/mois de
 * maintenance : en mode `subscription`, un prix ponctuel placé dans
 * `line_items` est ajouté à la première facture. Le client règle et signe une
 * fois, en rendez-vous, et n'a plus rien à ressaisir ensuite.
 *
 * Rien de ce que le navigateur envoie n'est cru sur parole : les montants
 * viennent des `Price` Stripe, et l'attribution de la fiche est revérifiée ici.
 */

import { stripe, stripeConfigure, STRIPE_ABSENT } from "../_shared/stripe.ts";
import { db } from "../_shared/db.ts";
import { reponse, CORS } from "../_shared/cors.ts";
import { ancreFacturation } from "../_shared/ancre.ts";
import { prix } from "../_shared/prix.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reponse({ error: "Méthode non autorisée." }, 405);

  const jeton = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!jeton) return reponse({ error: "Authentification requise." }, 401);

  const sb = db();
  const { data: { user }, error: errAuth } = await sb.auth.getUser(jeton);
  if (errAuth || !user) return reponse({ error: "Session invalide." }, 401);

  let corps: { prospect_id?: string; billing_day?: number };
  try {
    corps = await req.json();
  } catch {
    return reponse({ error: "Requête illisible." }, 400);
  }
  const { prospect_id, billing_day } = corps;
  if (!prospect_id) return reponse({ error: "Fiche non précisée." }, 422);

  // Un secret oublié doit se dire, pas se manifester par une panne.
  if (!stripeConfigure) return reponse({ error: STRIPE_ABSENT }, 503);

  const { data: fiche } = await sb
    .from("prospects")
    .select("id, company_name, email, assigned_to, paid_at, payment_status, stripe_customer_id")
    .eq("id", prospect_id)
    .maybeSingle();
  if (!fiche) return reponse({ error: "Fiche introuvable." }, 404);

  // Le navigateur a beau avoir vérifié : on refait tout ici, c'est le seul
  // contrôle que l'utilisateur ne peut pas contourner.
  const { data: moi } = await sb
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (fiche.assigned_to !== user.id && moi?.role !== "admin") {
    return reponse({ error: "Cette fiche ne vous est pas attribuée." }, 403);
  }
  if (fiche.paid_at) return reponse({ error: "Cette vente est déjà encaissée." }, 409);
  if (!fiche.email) {
    return reponse({ error: "La fiche n'a pas d'adresse e-mail : ajoutez-la avant d'encaisser." }, 422);
  }

  let ancre: number;
  try {
    ancre = ancreFacturation(Number(billing_day), new Date());
  } catch (e) {
    return reponse({ error: (e as Error).message }, 422);
  }

  try {
    let clientId = fiche.stripe_customer_id;
    if (!clientId) {
      const c = await stripe.customers.create({
        email: fiche.email,
        name: fiche.company_name,
        metadata: { prospect_id: fiche.id },
      });
      clientId = c.id;
      await sb.from("prospects").update({ stripe_customer_id: clientId }).eq("id", fiche.id);
    }

    const racine = Deno.env.get("NORYA_URL") ?? "";
    const meta = {
      prospect_id: fiche.id,
      commercial_id: fiche.assigned_to ?? "",
    };

    // Résolus par clé de recherche dans le compte de la clé secrète, jamais
    // recopiés d'un compte à l'autre.
    const tarifs = await prix();

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: clientId,
      line_items: [
        { price: tarifs.maintenance, quantity: 1 },
        // Prix ponctuel : en mode subscription il n'apparaît que sur la
        // première facture, ce qui encaisse le site et arme la maintenance
        // en une seule opération.
        { price: tarifs.site, quantity: 1 },
      ],
      payment_method_types: ["card", "sepa_debit"],
      locale: "fr",
      subscription_data: {
        // Et non billing_cycle_anchor : Stripe refuse proration_behavior
        // « none » dès qu'une session contient un prix ponctuel, et sans lui
        // le client se verrait facturer en plus un prorata de maintenance
        // jusqu'à l'ancre — ce que la modale ne lui annonce pas. Une période
        // d'essai jusqu'au jour choisi donne le comportement promis : 800 €
        // aujourd'hui, puis 49 € le jour dit, et tous les mois à cette date.
        trial_end: ancre,
        metadata: meta,
      },
      metadata: meta,
      success_url: `${racine}/?paiement=ok&fiche=${fiche.id}`,
      cancel_url: `${racine}/?paiement=annule&fiche=${fiche.id}`,
    });

    // « en_cours » et non « réglé » : en SEPA la compensation prend des jours,
    // et c'est le webhook qui tranchera.
    await sb
      .from("prospects")
      .update({ payment_status: "en_cours", billing_day: Number(billing_day) })
      .eq("id", fiche.id);

    return reponse({ url: session.url });
  } catch (e) {
    console.error("create-checkout :", e);
    return reponse({ error: `Stripe a refusé la demande : ${(e as Error).message}` }, 502);
  }
});

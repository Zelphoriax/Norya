/**
 * Point d'entrée du webhook Stripe.
 *
 * Seule autorité sur ce qui est payé : le navigateur ne décide jamais qu'une
 * vente est encaissée, il ouvre une session de paiement et c'est tout. Ici on
 * vérifie la signature, on réserve l'événement contre les rejeux, puis on
 * applique les effets décidés par effetsPour().
 *
 * Aucun JWT : Stripe n'a pas de session Supabase (voir config.toml). C'est la
 * signature qui authentifie.
 *
 * Durabilité — trois filets, parce qu'un versement perdu ou doublé se paie
 * cher et se rattrape mal :
 *
 *  1. La réservation dans stripe_events empêche deux livraisons simultanées
 *     du même événement de se marcher dessus.
 *  2. Si l'application échoue, la réservation est levée et on renvoie 500 :
 *     Stripe réessaie, et l'événement est bien retraité plutôt que perdu.
 *  3. Chaque effet est rejouable sans dommage — ce qui rend (2) sûr. Les
 *     insertions passent par des contraintes d'unicité, et les virements
 *     portent une clé d'idempotence côté Stripe.
 */

import { stripe } from "../_shared/stripe.ts";
import { db } from "../_shared/db.ts";
import { effetsPour, type Effet, type Evenement } from "./effets.ts";

type Base = ReturnType<typeof db>;

/** Ce qu'un effet transmet au suivant, dans le même événement. */
type Etat = { paiementId: string | null };

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Signature absente", { status: 400 });

  const brut = await req.text();
  let ev;
  try {
    // constructEventAsync et non constructEvent : la variante synchrone exige
    // un crypto bloquant que Deno n'a pas.
    ev = await stripe.webhooks.constructEventAsync(
      brut,
      signature,
      Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "",
    );
  } catch (e) {
    return new Response(`Signature invalide : ${(e as Error).message}`, { status: 400 });
  }

  const sb = db();

  // Réservation. Le conflit de clé primaire fait foi : si la ligne existe
  // déjà, un autre traitement de cet événement a eu lieu ou est en cours.
  const { error: conflit } = await sb
    .from("stripe_events")
    .insert({ id: ev.id, type: ev.type });
  if (conflit) return new Response("Déjà traité", { status: 200 });

  try {
    const ctx = { commercialOnboarde: await onboarde(sb, ev) };
    const etat: Etat = { paiementId: null };

    for (const effet of effetsPour(ev as unknown as Evenement, ctx)) {
      await appliquer(sb, effet, etat, ev.id);
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    // On lève la réservation pour que le rejeu de Stripe retraite vraiment
    // l'événement. Sans cela, un échec ici enterrerait le versement.
    await sb.from("stripe_events").delete().eq("id", ev.id);
    console.error(`Échec sur ${ev.type} (${ev.id}) :`, e);
    return new Response(`Échec du traitement : ${(e as Error).message}`, { status: 500 });
  }
});

/** Le commercial de cette vente peut-il déjà recevoir des virements ? */
// deno-lint-ignore no-explicit-any
async function onboarde(sb: Base, ev: any): Promise<boolean> {
  const id = ev.data?.object?.subscription_details?.metadata?.commercial_id;
  if (!id) return false;
  const { data } = await sb
    .from("profiles")
    .select("stripe_payouts_enabled")
    .eq("id", id)
    .maybeSingle();
  return !!data?.stripe_payouts_enabled;
}

async function appliquer(sb: Base, e: Effet, etat: Etat, eventId: string): Promise<void> {
  switch (e.type) {
    case "rattacher_client": {
      if (!e.prospectId) return;
      const { error } = await sb
        .from("prospects")
        .update({
          stripe_customer_id: e.customerId,
          stripe_subscription_id: e.subscriptionId,
        })
        .eq("id", e.prospectId);
      if (error) throw error;
      return;
    }

    case "enregistrer_paiement": {
      if (!e.prospectId) return;
      // stripe_invoice_id est unique : un rejeu ne crée pas de doublon, il
      // retombe sur la ligne existante.
      const { error } = await sb.from("payments").upsert({
        prospect_id: e.prospectId,
        commercial_id: e.commercialId,
        type: e.nature,
        amount_cents: e.montantCents,
        stripe_invoice_id: e.invoiceId,
        stripe_payment_intent_id: e.paymentIntentId,
        status: "paye",
        paid_at: new Date().toISOString(),
      }, { onConflict: "stripe_invoice_id", ignoreDuplicates: true });
      if (error) throw error;

      // On relit l'identifiant plutôt que de chercher plus tard par
      // prospect_id : une fiche peut porter plusieurs encaissements, et une
      // recherche approximative verserait la commission sur le mauvais.
      const { data, error: errLecture } = await sb
        .from("payments")
        .select("id")
        .eq("stripe_invoice_id", e.invoiceId)
        .single();
      if (errLecture) throw errLecture;
      etat.paiementId = data.id;
      return;
    }

    case "marquer_paye": {
      if (!e.prospectId) return;
      const { error } = await sb
        .from("prospects")
        .update({ paid_at: new Date().toISOString(), payment_status: "regle" })
        .eq("id", e.prospectId);
      if (error) throw error;
      return;
    }

    case "marquer_statut": {
      if (!e.prospectId) return;
      const { error } = await sb
        .from("prospects")
        .update({ payment_status: e.statut })
        .eq("id", e.prospectId);
      if (error) throw error;
      return;
    }

    case "marquer_litige": {
      if (!e.paymentIntentId) return;
      const { data } = await sb
        .from("payments")
        .select("prospect_id")
        .eq("stripe_payment_intent_id", e.paymentIntentId)
        .maybeSingle();
      if (!data?.prospect_id) return;

      const { error } = await sb
        .from("prospects")
        .update({ payment_status: "litige" })
        .eq("id", data.prospect_id);
      if (error) throw error;
      return;
    }

    case "mettre_en_file": {
      if (!etat.paiementId) return;
      // L'index unique sur payment_id empêche une seconde ligne.
      const { error } = await sb.from("commission_transfers").upsert({
        payment_id: etat.paiementId,
        commercial_id: e.commercialId,
        amount_cents: e.montantCents,
        status: "en_attente_onboarding",
      }, { onConflict: "payment_id", ignoreDuplicates: true });
      if (error) throw error;
      return;
    }

    case "verser_commission": {
      if (!etat.paiementId) return;

      // Déjà versée ? Un rejeu ne doit pas refaire partir 320 €.
      const { data: deja } = await sb
        .from("commission_transfers")
        .select("id, status")
        .eq("payment_id", etat.paiementId)
        .maybeSingle();
      if (deja?.status === "verse") return;

      const { data: profil } = await sb
        .from("profiles")
        .select("stripe_account_id")
        .eq("id", e.commercialId)
        .maybeSingle();
      if (!profil?.stripe_account_id) return;

      const virement = await stripe.transfers.create({
        amount: e.montantCents,
        currency: "eur",
        destination: profil.stripe_account_id,
        metadata: { prospect_id: e.prospectId, payment_id: etat.paiementId },
        // Deuxième verrou, côté Stripe : même rejoué, cet appel ne crée
        // qu'un seul virement.
      }, { idempotencyKey: `commission-${etat.paiementId}` });

      const { error } = await sb.from("commission_transfers").upsert({
        payment_id: etat.paiementId,
        commercial_id: e.commercialId,
        amount_cents: e.montantCents,
        stripe_transfer_id: virement.id,
        status: "verse",
      }, { onConflict: "payment_id" });
      if (error) throw error;
      return;
    }

    case "maj_compte": {
      const { error } = await sb
        .from("profiles")
        .update({ stripe_payouts_enabled: e.payoutsActifs })
        .eq("stripe_account_id", e.compteId);
      if (error) throw error;
      return;
    }

    case "rejouer_file": {
      const { data: profil } = await sb
        .from("profiles")
        .select("id")
        .eq("stripe_account_id", e.compteId)
        .maybeSingle();
      if (!profil) return;

      const { data: attente } = await sb
        .from("commission_transfers")
        .select("id, payment_id, amount_cents")
        .eq("commercial_id", profil.id)
        .eq("status", "en_attente_onboarding");

      for (const ligne of attente ?? []) {
        const virement = await stripe.transfers.create({
          amount: ligne.amount_cents,
          currency: "eur",
          destination: e.compteId,
          metadata: { payment_id: ligne.payment_id, origine: eventId },
        }, { idempotencyKey: `commission-${ligne.payment_id}` });

        const { error } = await sb
          .from("commission_transfers")
          .update({ stripe_transfer_id: virement.id, status: "verse" })
          .eq("id", ligne.id);
        if (error) throw error;
      }
      return;
    }
  }
}

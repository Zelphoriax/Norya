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
import { MONTANT_SITE_DEFAUT_CENTS } from "../_shared/config.ts";

type Base = ReturnType<typeof db>;

/** Ce qu'un effet transmet au suivant, dans le même événement. */
type Etat = { paiementId: string | null };

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Signature absente", { status: 400 });

  const brut = await req.text();
  const ev = await verifier(brut, signature);
  if (!ev) return new Response("Signature invalide", { status: 400 });

  const sb = db();

  // Réservation. Le conflit de clé primaire fait foi : si la ligne existe
  // déjà, un autre traitement de cet événement a eu lieu ou est en cours.
  const { error: conflit } = await sb
    .from("stripe_events")
    .insert({ id: ev.id, type: ev.type });
  if (conflit) return new Response("Déjà traité", { status: 200 });

  try {
    const ctx = await contexte(sb, ev);
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

/**
 * Vérifie la signature contre chacun des secrets connus.
 *
 * `STRIPE_WEBHOOK_SECRET` accepte une liste séparée par des virgules, parce
 * qu'un compte Stripe a besoin de deux points d'entrée distincts : l'un pour
 * les événements de la plateforme — encaissements, factures, litiges — et
 * l'autre pour ceux des comptes connectés, dont `account.updated`, celui qui
 * libère une commission mise en file quand un commercial achève sa
 * vérification. Chaque point d'entrée signe avec son propre secret, et
 * n'en connaître qu'un rendait la seconde famille d'événements muette.
 *
 * constructEventAsync et non constructEvent : la variante synchrone exige un
 * crypto bloquant que Deno n'a pas.
 */
async function verifier(brut: string, signature: string) {
  const secrets = (Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  for (const secret of secrets) {
    try {
      return await stripe.webhooks.constructEventAsync(brut, signature, secret);
    } catch { /* secret suivant */ }
  }
  console.error(
    `Aucun des ${secrets.length} secret(s) de signature ne correspond à cet appel.`,
  );
  return null;
}

/**
 * Résout la fiche et le commercial avant toute décision.
 *
 * Les métadonnées d'abord, à leurs deux emplacements : Stripe a déplacé
 * `subscription_details` sous `parent` avec l'API 2025, et lire le seul
 * ancien chemin a suffi à faire disparaître un encaissement sans un bruit.
 * Puis, si elles manquent, le client Stripe — que la fiche porte déjà depuis
 * create-checkout. Ce repli est l'important : une métadonnée est une
 * commodité, le rattachement du client est un fait enregistré chez nous.
 */
// deno-lint-ignore no-explicit-any
async function contexte(sb: Base, ev: any) {
  const o = ev.data?.object ?? {};
  const meta = o.parent?.subscription_details?.metadata ??
    o.subscription_details?.metadata ??
    o.metadata ??
    {};

  let prospectId: string | null = meta.prospect_id ?? null;
  let commercialId: string | null = meta.commercial_id || null;

  if (!prospectId && typeof o.customer === "string") {
    const { data } = await sb
      .from("prospects")
      .select("id, assigned_to")
      .eq("stripe_customer_id", o.customer)
      .maybeSingle();
    if (data) {
      prospectId = data.id;
      commercialId = commercialId ?? data.assigned_to ?? null;
    }
  }

  // La formule retenue, telle que create-checkout l'a inscrite sur la fiche.
  // C'est elle qui fixe l'encaissement et la commission, pas la facture.
  let montantSiteCents = MONTANT_SITE_DEFAUT_CENTS;
  if (prospectId) {
    const { data } = await sb
      .from("prospects")
      .select("sale_amount, assigned_to")
      .eq("id", prospectId)
      .maybeSingle();
    if (data?.sale_amount) montantSiteCents = Math.round(Number(data.sale_amount) * 100);
    commercialId = commercialId ?? data?.assigned_to ?? null;
  }

  let commercialOnboarde = false;
  if (commercialId) {
    const { data } = await sb
      .from("profiles")
      .select("stripe_payouts_enabled")
      .eq("id", commercialId)
      .maybeSingle();
    commercialOnboarde = !!data?.stripe_payouts_enabled;
  }

  return { commercialOnboarde, prospectId, commercialId, montantSiteCents };
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

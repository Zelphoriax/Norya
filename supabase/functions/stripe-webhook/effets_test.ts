import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { effetsPour } from "./effets.ts";

/* Décision pure : aucun réseau, aucune base. On vérifie ce que le webhook
   DÉCIDE de faire, pas comment il le fait — c'est là que se joue le fait de
   ne jamais verser deux fois 320 €, ni d'en verser sur une maintenance. */

/* prospectId et commercialId sont résolus par index.ts avant la décision :
   métadonnées aux deux emplacements connus, puis repli sur le client Stripe. */
const ONBOARDE = { commercialOnboarde: true, prospectId: "pr_1", commercialId: "co_1" };
const NON_ONBOARDE = { commercialOnboarde: false, prospectId: "pr_1", commercialId: "co_1" };
const SANS_COMMERCIAL = { commercialOnboarde: true, prospectId: "pr_1", commercialId: null };
const SANS_FICHE = { commercialOnboarde: true, prospectId: null, commercialId: null };

const facture = (extra: Record<string, unknown> = {}) => ({
  type: "invoice.paid",
  data: {
    object: {
      id: "in_1",
      billing_reason: "subscription_create",
      amount_paid: 84_900, // 800 EUR de site + 49 EUR de premier mois
      payment_intent: "pi_1",
      ...extra,
    },
  },
});

Deno.test("session terminée : on rattache, on ne paie pas", () => {
  // En SEPA, rien n'est acquis à ce stade : la compensation prend des jours.
  const e = effetsPour({
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { prospect_id: "pr_1" },
      },
    },
  }, ONBOARDE);

  assertEquals(e, [{
    type: "rattacher_client",
    prospectId: "pr_1",
    customerId: "cus_1",
    subscriptionId: "sub_1",
  }]);
});

Deno.test("première facture : encaissement, paid_at, commission", () => {
  const e = effetsPour(facture(), ONBOARDE);
  assertEquals(e.map((x) => x.type), [
    "enregistrer_paiement",
    "marquer_paye",
    "verser_commission",
  ]);
  assertEquals(e[0], {
    type: "enregistrer_paiement",
    prospectId: "pr_1",
    commercialId: "co_1",
    nature: "site",
    montantCents: 80_000,
    invoiceId: "in_1",
    paymentIntentId: "pi_1",
  });
  assertEquals(e[2], {
    type: "verser_commission",
    prospectId: "pr_1",
    commercialId: "co_1",
    montantCents: 32_000,
  });
});

Deno.test("le site vaut 800 EUR, pas le total de la facture", () => {
  // amount_paid vaut 849 EUR : le site plus le premier mois de maintenance.
  // L'enregistrer tel quel fausserait le compteur de CA et la commission.
  const e = effetsPour(facture(), ONBOARDE);
  const enregistrement = e[0] as { montantCents: number };
  assertEquals(enregistrement.montantCents, 80_000);
});

Deno.test("première facture, commercial non vérifié : on met en file", () => {
  const e = effetsPour(facture(), NON_ONBOARDE);
  assertEquals(e.map((x) => x.type), [
    "enregistrer_paiement",
    "marquer_paye",
    "mettre_en_file",
  ]);
  assertEquals(e[2], {
    type: "mettre_en_file",
    prospectId: "pr_1",
    commercialId: "co_1",
    montantCents: 32_000,
  });
});

Deno.test("vente sans commercial attribué : aucune commission", () => {
  const e = effetsPour(facture(), SANS_COMMERCIAL);
  assertEquals(e.map((x) => x.type), ["enregistrer_paiement", "marquer_paye"]);
});

Deno.test("facture payée sans fiche identifiable : on lève, on n'avale pas", () => {
  // Le silence est le pire comportement possible ici : c'est exactement ainsi
  // qu'un encaissement de 800 € a disparu quand Stripe a déplacé les
  // métadonnées sous parent.subscription_details.
  assertThrows(
    () => effetsPour(facture(), SANS_FICHE),
    Error,
    "sans fiche identifiable",
  );
});

Deno.test("facture de maintenance : aucune commission", () => {
  const e = effetsPour(
    facture({ billing_reason: "subscription_cycle", amount_paid: 4_900 }),
    ONBOARDE,
  );
  assertEquals(e.map((x) => x.type), ["enregistrer_paiement"]);
  assertEquals(e[0], {
    type: "enregistrer_paiement",
    prospectId: "pr_1",
    commercialId: "co_1",
    nature: "maintenance",
    montantCents: 4_900,
    invoiceId: "in_1",
    paymentIntentId: "pi_1",
  });
});

Deno.test("échec de paiement", () => {
  assertEquals(
    effetsPour({
      type: "invoice.payment_failed",
      data: {
        object: {
          subscription_details: { metadata: { prospect_id: "pr_1" } },
        },
      },
    }, ONBOARDE),
    [{ type: "marquer_statut", prospectId: "pr_1", statut: "echec" }],
  );
});

Deno.test("litige : identifié par le payment_intent, pas par les métadonnées", () => {
  // Une charge ne porte pas prospect_id : les métadonnées sont posées sur la
  // session et l'abonnement. Lire o.metadata ici aurait toujours donné vide,
  // et le litige serait passé inaperçu.
  assertEquals(
    effetsPour({
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", charge: "ch_1", payment_intent: "pi_1" } },
    }, ONBOARDE),
    [{ type: "marquer_litige", paymentIntentId: "pi_1" }],
  );
});

Deno.test("compte vérifié : on rejoue la file d'attente", () => {
  assertEquals(
    effetsPour({
      type: "account.updated",
      data: { object: { id: "acct_1", payouts_enabled: true } },
    }, ONBOARDE),
    [
      { type: "maj_compte", compteId: "acct_1", payoutsActifs: true },
      { type: "rejouer_file", compteId: "acct_1" },
    ],
  );
});

Deno.test("compte encore incomplet : pas de rejeu", () => {
  assertEquals(
    effetsPour({
      type: "account.updated",
      data: { object: { id: "acct_1", payouts_enabled: false } },
    }, ONBOARDE),
    [{ type: "maj_compte", compteId: "acct_1", payoutsActifs: false }],
  );
});

Deno.test("événement inconnu : aucun effet", () => {
  assertEquals(
    effetsPour({ type: "customer.created", data: { object: {} } }, ONBOARDE),
    [],
  );
});

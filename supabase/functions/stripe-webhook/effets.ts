/**
 * Ce que le webhook décide, séparé de ce qu'il fait.
 *
 * Cette fonction est pure : elle prend un événement Stripe et l'état connu du
 * commercial, et renvoie la liste des effets à appliquer. Aucun réseau, aucune
 * base — c'est ce qui rend la règle de versement testable, et c'est là que se
 * joue le fait de ne jamais verser deux fois 320 €, ni d'en verser sur une
 * simple mensualité de maintenance.
 *
 * L'application de ces effets vit dans index.ts.
 */

import { COMMISSION_CENTS, MONTANT_SITE_CENTS } from "../_shared/config.ts";

export type Effet =
  | {
    type: "rattacher_client";
    prospectId: string;
    customerId: string;
    subscriptionId: string;
  }
  | {
    type: "enregistrer_paiement";
    prospectId: string;
    commercialId: string | null;
    nature: "site" | "maintenance";
    montantCents: number;
    invoiceId: string;
    paymentIntentId: string | null;
  }
  | { type: "marquer_paye"; prospectId: string }
  | {
    type: "verser_commission";
    prospectId: string;
    commercialId: string;
    montantCents: number;
  }
  | {
    type: "mettre_en_file";
    prospectId: string;
    commercialId: string;
    montantCents: number;
  }
  | { type: "marquer_statut"; prospectId: string; statut: string }
  // Un litige ne nomme pas le prospect : les métadonnées vivent sur la session
  // et l'abonnement, jamais sur la charge. On passe par le payment_intent, que
  // la table payments garde, et l'application remonte jusqu'à la fiche.
  | { type: "marquer_litige"; paymentIntentId: string }
  | { type: "maj_compte"; compteId: string; payoutsActifs: boolean }
  | { type: "rejouer_file"; compteId: string };

/** Ce que la base sait déjà, et que l'événement ne dit pas. */
export type Contexte = { commercialOnboarde: boolean };

// deno-lint-ignore no-explicit-any
type Objet = Record<string, any>;
export type Evenement = { type: string; data: { object: Objet } };

export function effetsPour(ev: Evenement, ctx: Contexte): Effet[] {
  const o = ev.data.object;

  switch (ev.type) {
    case "checkout.session.completed":
      // Volontairement pas de marquer_paye : en prélèvement SEPA, rien n'est
      // acquis ici. C'est invoice.paid, des jours plus tard, qui tranche.
      return [{
        type: "rattacher_client",
        prospectId: o.metadata?.prospect_id,
        customerId: o.customer,
        subscriptionId: o.subscription,
      }];

    case "invoice.paid": {
      const meta = o.subscription_details?.metadata ?? {};
      const prospectId: string = meta.prospect_id;
      const commercialId: string | null = meta.commercial_id || null;
      const premiere = o.billing_reason === "subscription_create";

      const effets: Effet[] = [{
        type: "enregistrer_paiement",
        prospectId,
        commercialId,
        nature: premiere ? "site" : "maintenance",
        // Sur la première facture, amount_paid vaut 849 € : le site plus le
        // premier mois. Enregistrer ce total comme prix du site fausserait
        // le compteur de CA face au seuil de TVA. On prend la constante.
        montantCents: premiere ? MONTANT_SITE_CENTS : o.amount_paid,
        invoiceId: o.id,
        paymentIntentId: o.payment_intent ?? null,
      }];

      // Une mensualité de maintenance ne commissionne pas : le barème fixe
      // recurring_commission_rate à 0. Seule la vente du site le fait.
      if (!premiere) return effets;

      effets.push({ type: "marquer_paye", prospectId });

      if (commercialId) {
        effets.push({
          type: ctx.commercialOnboarde ? "verser_commission" : "mettre_en_file",
          prospectId,
          commercialId,
          montantCents: COMMISSION_CENTS,
        });
      }
      return effets;
    }

    case "invoice.payment_failed":
      return [{
        type: "marquer_statut",
        prospectId: o.subscription_details?.metadata?.prospect_id,
        statut: "echec",
      }];

    case "charge.dispute.created":
      return [{
        type: "marquer_litige",
        paymentIntentId: o.payment_intent,
      }];

    case "account.updated": {
      const effets: Effet[] = [{
        type: "maj_compte",
        compteId: o.id,
        payoutsActifs: !!o.payouts_enabled,
      }];
      // Le commercial vient d'être vérifié : les commissions mises de côté
      // pendant l'attente peuvent enfin partir.
      if (o.payouts_enabled) {
        effets.push({ type: "rejouer_file", compteId: o.id });
      }
      return effets;
    }

    default:
      return [];
  }
}

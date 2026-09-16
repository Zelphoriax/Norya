import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { ancreFacturation } from "./ancre.ts";

/* L'ancre est exprimée en secondes, comme Stripe l'attend. On la relit en
   ISO pour que chaque attente reste lisible.

   Le raisonnement se fait en heure civile de Paris, pas en UTC : le client
   voit « le 20 » et doit être prélevé le 20 chez lui. Minuit à Paris tombe
   donc à 22 h UTC la veille en été (CEST) et 23 h UTC en hiver (CET) —
   c'est ce décalage qu'on retrouve dans chaque attente ci-dessous. */
const iso = (s: number) => new Date(s * 1000).toISOString();

Deno.test("jour à venir dans le mois courant", () => {
  const t = ancreFacturation(20, new Date("2026-09-16T14:00:00Z"));
  assertEquals(iso(t), "2026-09-19T22:00:00.000Z"); // 20 sept. 00:00 CEST
});

Deno.test("jour déjà passé : mois suivant", () => {
  const t = ancreFacturation(5, new Date("2026-09-16T14:00:00Z"));
  assertEquals(iso(t), "2026-10-04T22:00:00.000Z"); // 5 oct. 00:00 CEST
});

Deno.test("le jour même bascule au mois suivant, comme nextBilling", () => {
  const t = ancreFacturation(16, new Date("2026-09-16T14:00:00Z"));
  assertEquals(iso(t), "2026-10-15T22:00:00.000Z"); // 16 oct. 00:00 CEST
});

Deno.test("passage d'année, en heure d'hiver", () => {
  const t = ancreFacturation(5, new Date("2026-12-20T09:00:00Z"));
  assertEquals(iso(t), "2027-01-04T23:00:00.000Z"); // 5 janv. 00:00 CET
});

Deno.test("le 28 reste valide en février", () => {
  const t = ancreFacturation(28, new Date("2027-01-29T09:00:00Z"));
  assertEquals(iso(t), "2027-02-27T23:00:00.000Z"); // 28 févr. 00:00 CET
});

Deno.test("jour d'un changement d'heure : minuit est encore en CET", () => {
  // Le passage à l'heure d'été 2027 a lieu le 28 mars à 02:00 CET.
  // À minuit ce jour-là, Paris est donc encore à UTC+1.
  const t = ancreFacturation(28, new Date("2027-03-20T12:00:00Z"));
  assertEquals(iso(t), "2027-03-27T23:00:00.000Z");
});

Deno.test("plein été : décalage de deux heures", () => {
  const t = ancreFacturation(15, new Date("2026-07-01T08:00:00Z"));
  assertEquals(iso(t), "2026-07-14T22:00:00.000Z"); // 15 juil. 00:00 CEST
});

Deno.test("jour hors plage refusé", () => {
  assertThrows(() => ancreFacturation(0, new Date()), Error, "1 et 28");
  assertThrows(() => ancreFacturation(29, new Date()), Error, "1 et 28");
  assertThrows(() => ancreFacturation(5.5, new Date()), Error, "1 et 28");
});

/**
 * En-têtes CORS des fonctions appelées depuis le navigateur.
 *
 * L'origine est celle de Norya en ligne, pas `*` : ces fonctions ouvrent des
 * sessions de paiement au nom d'un commercial authentifié. On retombe sur `*`
 * seulement si `NORYA_URL` n'est pas renseignée, pour ne pas rendre une
 * fonction muette à cause d'un secret oublié — le contrôle qui compte reste
 * la vérification du jeton, pas l'en-tête.
 */
export const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("NORYA_URL") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Réponse JSON, en-têtes CORS inclus. */
export function reponse(corps: unknown, statut = 200): Response {
  return new Response(JSON.stringify(corps), {
    status: statut,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

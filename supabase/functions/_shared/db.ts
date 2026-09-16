import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

/**
 * Client Supabase en `service_role` : il contourne la RLS.
 *
 * Réservé aux Edge Functions, et jamais exposé au navigateur. C'est ce qui
 * permet au webhook d'écrire `paid_at` et les commissions alors qu'aucun
 * utilisateur n'est connecté — Stripe n'a pas de session Norya.
 *
 * `persistSession: false` : une fonction sans état ne doit rien garder d'une
 * invocation à la suivante.
 */
export function db(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

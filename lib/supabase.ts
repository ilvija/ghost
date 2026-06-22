import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./config";

// Server-side client for the chat API route. Uses the anon key; the only data
// path is the match_help_chunks RPC (security definer), so anon is sufficient.
export function supabaseServer() {
  return createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    { auth: { persistSession: false } }
  );
}

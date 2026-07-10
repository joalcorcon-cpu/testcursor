import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const hasPublicSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);
export const hasServerSupabaseConfig = Boolean(supabaseUrl && supabaseServiceRole);

export const getSupabaseBrowserClient = () => {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase public environment variables are missing.");
  }
  return createClient(supabaseUrl, supabaseAnonKey);
};

export const getSupabaseServerClient = () => {
  if (!supabaseUrl || !supabaseServiceRole) {
    throw new Error("Supabase server environment variables are missing.");
  }
  return createClient(supabaseUrl, supabaseServiceRole, {
    auth: {
      persistSession: false
    }
  });
};

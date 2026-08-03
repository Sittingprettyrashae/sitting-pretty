// Stripe client for Deno edge functions.
// STRIPE_SECRET_KEY is set via supabase secrets (RUNBOOK step 3) and belongs
// to KE'EBONIE'S OWN Stripe account. Payouts go to her bank, never through
// Nelson's account (RUNBOOK step 1).

import Stripe from "npm:stripe@17";

import { HttpError } from "./http.ts";

let cached: Stripe | null = null;

export function getStripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new HttpError(503, "Payments are not configured yet");
  if (!cached) {
    cached = new Stripe(key, {
      // Deno has no Node http stack; use the fetch client.
      httpClient: Stripe.createFetchHttpClient(),
    });
  }
  return cached;
}

// Webhook signature verification must use the async SubtleCrypto provider on
// the edge runtime (the sync default needs Node crypto).
export const stripeCryptoProvider = Stripe.createSubtleCryptoProvider();

// Sitting Pretty production API, deployed as ONE Supabase edge function
// named "api" so the /api/* paths in API.md map 1:1 onto
// https://<project-ref>.supabase.co/functions/v1/api/*.
//
// Deploy with --no-verify-jwt (RUNBOOK step 3): /services, /hours, and
// /availability are public, and Stripe calls /stripe/webhook without a
// Supabase JWT.
// Everything that needs auth enforces it in code via _shared/auth.ts.
//
// Auth: password, Google, and the email code are all native Supabase Auth
// calls made from the browser with supabase-js, so most of API.md's
// /api/auth/* endpoints have no server side here. The two that do
// (/auth/bootstrap and /auth/logout) live in auth.ts; the rest answer 410
// naming the supabase-js call that replaced them. See _shared/auth.ts.
//
// Demo-only endpoints from API.md that do NOT exist here on purpose:
// - /api/checkout/* and /api/_outbox, /api/_reset : demo simulations. In
//   production checkout_url is a real Stripe Checkout page and the outbox
//   is the notifications_log table.

import { sweepExpiredDeposits } from "../_shared/deposits.ts";
import { sweepExpiredHolds } from "../_shared/holds.ts";
import { corsHeaders, errorResponse, HttpError } from "../_shared/http.ts";
import { handleAuth } from "./auth.ts";
import {
  handleAvailability,
  handleCreateBooking,
  handleHours,
  handlePayBalance,
  handleRefreshHold,
  handleServices,
} from "./bookings.ts";
import { handleCreateLead, handleCreateReview, handleListReviews } from "./community.ts";
import { handleCreateSlotAlert } from "./alerts.ts";
import { handleMe } from "./me.ts";
import { handleCancel } from "./cancel.ts";
import { handleAdmin } from "./admin.ts";
import { handleStripeWebhook } from "./stripe-webhook.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Inside the function the pathname still starts with the function name
  // (and, in some runtime versions, with /functions/v1). Strip both.
  const path = url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/api/, "") || "/";

  try {
    // Housekeeping before anything that reads availability or bookings, the
    // same four paths the demo sweeps on (server/server.mjs). A slot must
    // never stay locked by an abandoned checkout, and an appointment whose
    // deposit never arrived must not keep sitting on her calendar. Both
    // sweeps log their own failures and never break the request.
    if (
      path === "/availability" || path === "/me" || path === "/bookings" ||
      path === "/admin/bookings"
    ) {
      await sweepExpiredHolds();
      await sweepExpiredDeposits();
    }

    if (req.method === "GET" && path === "/services") return await handleServices();
    if (req.method === "GET" && path === "/hours") return await handleHours();
    if (req.method === "GET" && path === "/availability") return await handleAvailability(url);
    if (path === "/me") return await handleMe(req);
    if (req.method === "POST" && path === "/bookings") return await handleCreateBooking(req);
    if (req.method === "POST" && path === "/leads") return await handleCreateLead(req);
    if (req.method === "POST" && path === "/slot-alerts") return await handleCreateSlotAlert(req);
    if (req.method === "GET" && path === "/reviews") return await handleListReviews();
    if (req.method === "POST" && path === "/reviews") return await handleCreateReview(req);

    const holdRefreshMatch = path.match(/^\/holds\/([^/]+)\/refresh$/);
    if (req.method === "POST" && holdRefreshMatch) {
      return await handleRefreshHold(req, holdRefreshMatch[1]);
    }

    const cancelMatch = path.match(/^\/bookings\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) return await handleCancel(req, cancelMatch[1]);

    const payBalanceMatch = path.match(/^\/bookings\/([^/]+)\/pay-balance$/);
    if (req.method === "POST" && payBalanceMatch) {
      return await handlePayBalance(req, payBalanceMatch[1]);
    }

    if (req.method === "POST" && path === "/stripe/webhook") {
      return await handleStripeWebhook(req);
    }

    if (path.startsWith("/admin/")) return await handleAdmin(req, path);

    if (path.startsWith("/auth/")) return await handleAuth(req, path);
    if (path.startsWith("/checkout/") || path.startsWith("/_")) {
      return errorResponse(404, "Demo-only endpoint, not available in production");
    }

    return errorResponse(404, "Not found");
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    console.error("Unhandled error:", err);
    return errorResponse(500, "Something went wrong. Try again");
  }
});

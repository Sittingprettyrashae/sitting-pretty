// Shared HTTP helpers: CORS, JSON responses, error envelope per API.md
// ({ error: "<human message>" } with 4xx/5xx status).

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// GitHub Pages origin differs from *.supabase.co, so every response needs
// CORS headers. Set ALLOWED_ORIGIN to the site origin in production
// (RUNBOOK step 3); default * keeps local testing painless.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  // apikey is required: Supabase's gateway rejects an edge-function call with no
  // Authorization header, so an anonymous visitor has to send the anon key, and
  // the browser will not send a header the preflight has not allowed. Without
  // apikey here nobody who is not signed in can even load the price list.
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, stripe-signature",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(status: number, message: string): Response {
  return json({ error: message }, status);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object") throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

// Same as readJson, except no body at all is an empty object. For endpoints
// whose fields are ALL optional, where sending nothing is a valid request.
export async function readJsonOptional(req: Request): Promise<Record<string, unknown>> {
  const raw = (await req.text()).trim();
  if (!raw) return {};
  try {
    const body = JSON.parse(raw);
    if (body === null || typeof body !== "object") throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

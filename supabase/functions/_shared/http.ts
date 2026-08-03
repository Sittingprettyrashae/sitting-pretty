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
  "Access-Control-Allow-Headers": "authorization, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

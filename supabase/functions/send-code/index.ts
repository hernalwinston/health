// Dr. Mendoza Multi-Specialty Clinic
// Edge Function: send-code
//
// Why this exists: Supabase gives the database no outbound internet access,
// and this project's pg_net background worker never runs, so the database
// cannot call Brevo on its own. This function runs on Deno (which HAS
// internet access) and forwards the ready-made OTP e-mail payload to Brevo.
//
// The Brevo API key lives only in an Edge secret - it is never sent to the
// browser and never stored in the repository.
//
// Secrets to set (Dashboard -> Edge Functions -> send-code -> Secrets):
//   BREVO_API_KEY       e.g. xkeysib-...
//   CLINIC_SEND_SECRET  any long random string shared with the website

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const MAX_HTML = 60000;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-clinic-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function reply(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), { status, headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return reply(405, { ok: false, error: "Method not allowed." });
  }

  const apiKey = Deno.env.get("BREVO_API_KEY");
  if (!apiKey) {
    return reply(500, { ok: false, error: "Email service is not configured." });
  }

  // Optional shared secret so strangers cannot use this as a free mail relay.
  const secret = Deno.env.get("CLINIC_SEND_SECRET") ?? "";
  if (secret && req.headers.get("x-clinic-secret") !== secret) {
    return reply(403, { ok: false, error: "Not authorised." });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply(400, { ok: false, error: "Invalid request body." });
  }

  const to = String(body.to ?? "").trim();
  const subject = String(body.subject ?? "").trim() || "Clinic sign-in code";
  const html = String(body.html ?? "");
  const text = String(body.text ?? "");

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return reply(400, { ok: false, error: "Invalid recipient address." });
  }
  if (!html || html.length > MAX_HTML) {
    return reply(400, { ok: false, error: "Invalid message content." });
  }

  try {
    const res = await fetch(BREVO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: {
          name: "Dr. Mendoza Multi-Specialty Clinic",
          email: "hernalwinston@gmail.com",
        },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data: Record<string, unknown> = await res.json().catch(() => ({}));

    if (res.ok) {
      return reply(200, { ok: true, messageId: data.messageId ?? null });
    }

    const detail =
      typeof data.message === "string" && data.message
        ? data.message
        : `Brevo returned HTTP ${res.status}.`;
    return reply(502, { ok: false, error: detail });
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Network error.";
    return reply(502, { ok: false, error: "Unable to reach the e-mail service: " + detail });
  }
});

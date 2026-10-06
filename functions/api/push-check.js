export async function onRequest(context) {
  const { request, env } = context;

  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers });
  }

  if (!env.INTERCEDE_KV) {
    return new Response(JSON.stringify({ ok: true }), { headers });
  }

  // The client sends its subscription endpoint so we can mark that device as seen.
  let endpoint = null;
  try {
    const body = await request.json();
    endpoint = body.endpoint;
  } catch (_e) {}

  if (endpoint) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    const key = "push:" + hex.slice(0, 40);
    const raw = await env.INTERCEDE_KV.get(key);
    if (raw) {
      const record = JSON.parse(raw);
      record.lastSeen = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      await env.INTERCEDE_KV.put(key, JSON.stringify(record));
    }
  }

  return new Response(JSON.stringify({ ok: true }), { headers });
}

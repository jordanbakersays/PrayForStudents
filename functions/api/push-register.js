// Unique per-device key: SHA-256 of the full endpoint URL.
// (The old key used only the first 40 chars of base64(endpoint), which is identical for
// every device on the same push service, so devices overwrote each other.)
async function pushKey(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return "push:" + hex.slice(0, 40);
}

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
    return new Response(JSON.stringify({ error: "KV not bound" }), { status: 500, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON", detail: e.message }), { status: 400, headers });
  }

  const { subscription, reminderTime } = body;

  if (!subscription?.endpoint) {
    return new Response(JSON.stringify({ error: "Invalid subscription", received: JSON.stringify(body).slice(0, 200) }), { status: 400, headers });
  }

  const key = await pushKey(subscription.endpoint);
  let lastSeen = null;
  try {
    const prev = await env.INTERCEDE_KV.get(key);
    if (prev) lastSeen = JSON.parse(prev).lastSeen || null;
  } catch (_e) {}
  const record = { subscription, reminderTime: reminderTime || "09:00", lastSeen };
  await env.INTERCEDE_KV.put(key, JSON.stringify(record));

  // Clean up the legacy record for this same device (old key = first 40 chars of base64(endpoint)).
  // Left in place, the reminder sender would find the device twice and send duplicate reminders.
  // Only removed when it holds THIS device's subscription, so other devices are never affected.
  let legacyKey = null;
  try {
    const candidate = "push:" + btoa(subscription.endpoint).slice(0, 40);
    if (candidate !== key) {
      const legacyRaw = await env.INTERCEDE_KV.get(candidate);
      if (legacyRaw && JSON.parse(legacyRaw)?.subscription?.endpoint === subscription.endpoint) {
        await env.INTERCEDE_KV.delete(candidate);
        legacyKey = candidate;
      }
    }
  } catch (_e) {}

  const indexRaw = await env.INTERCEDE_KV.get("push:index");
  let index = indexRaw ? JSON.parse(indexRaw) : [];
  let changed = false;
  if (legacyKey && index.includes(legacyKey)) { index = index.filter(k => k !== legacyKey); changed = true; }
  if (!index.includes(key)) { index.push(key); changed = true; }
  if (changed) await env.INTERCEDE_KV.put("push:index", JSON.stringify(index));

  return new Response(JSON.stringify({ ok: true, key, reminderTime }), { headers });
}

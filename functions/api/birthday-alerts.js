// Birthday alerts for the admin.
//
// App actions (POST /api/birthday-alerts, JSON body {action, ...}):
//   register    {subscription, tz}                – save this device (alerts are fixed at 8:00 AM local)
//   unregister  {endpoint}                        – stop alerts for this device
//   status      {endpoint}                        – is this device registered?
//   test        {endpoint}                        – send a test notification now
//   message     {endpoint}                        – used by the service worker to fetch the text to show
// Scheduler action (called every few minutes by workers/birthday-cron):
//   run         header "x-cron-secret" must equal env.CRON_SECRET
//
// Required Pages settings:  VAPID_PRIVATE_KEY (secret), CRON_SECRET (secret).
// Optional:                 VAPID_PUBLIC_KEY, VAPID_SUBJECT.
// KV binding:               INTERCEDE_KV (already used by the rest of the app).

const DEFAULT_VAPID_PUBLIC_KEY =
  "BI4OYduhY_kBu_GJZtEsQAURClmTLOKMFM23GDuZ5EKd6z7dP5NcuCa0bZVv9eShUr9-gCFrhT1WenkRZAa4vJw";
const PREFIX = "bdayrec:";
const ALERT_TIME = "08:00";  // fixed daily alert time, in the device's local time zone
const SEND_WINDOW_MIN = 240; // don't send more than 4h after 8:00 (e.g. if the scheduler was down)

const enc = new TextEncoder();
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function b64u(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
async function recordId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(endpoint));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

// ── Web Push (VAPID, no payload) ─────────────────────────────
async function vapidAuthHeader(endpoint, env, siteOrigin) {
  const pubB64 = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_PUBLIC_KEY;
  const pub = unb64u(pubB64);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const header = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || siteOrigin,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${pubB64}`;
}

// Returns "ok" | "gone" | "error"
async function sendPush(record, env, siteOrigin) {
  try {
    const res = await fetch(record.subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthHeader(record.subscription.endpoint, env, siteOrigin),
        TTL: "3600",
        Urgency: "high",
      },
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "ok" : "error";
  } catch (_e) {
    return "error";
  }
}

// ── Dates & birthdays ────────────────────────────────────────
function localParts(tz, now = new Date()) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch (_e) {
    return localParts("UTC", now);
  }
  const p = Object.fromEntries(fmt.formatToParts(now).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: +p.year, month: +p.month, day: +p.day,
    minutes: (+p.hour) * 60 + (+p.minute),
  };
}
const toMinutes = hhmm => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

function birthdaysOn(people, { year, month, day }) {
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return people.filter(p => {
    if (!p || p.active === false || !p.birthday || !p.name) return false;
    const [m, d] = String(p.birthday).split("-").map(Number);
    if (!m || !d) return false;
    const resolvedDay = (m === 2 && d === 29 && !isLeap) ? 28 : d; // Feb 29 → Feb 28 in non-leap years
    return m === month && resolvedDay === day;
  }).map(p => p.name.trim());
}

function buildMessage(names) {
  if (names.length === 1) return { title: "🎂 Birthday today", body: `It's ${names[0]}'s birthday today!` };
  if (names.length === 2) return { title: "🎂 Birthdays today", body: `${names[0]} and ${names[1]} have birthdays today!` };
  const rest = names.length - 2;
  return { title: "🎂 Birthdays today", body: `${names[0]}, ${names[1]}, and ${rest} ${rest === 1 ? "other have" : "others have"} birthdays today!` };
}

async function loadPeople(env) {
  try {
    const raw = await env.INTERCEDE_KV.get("people");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_e) { return []; }
}

// ── Scheduled run ────────────────────────────────────────────
async function runScheduled(env, siteOrigin) {
  const summary = { checked: 0, sent: 0, skipped: 0, removed: 0, errors: 0 };
  const list = await env.INTERCEDE_KV.list({ prefix: PREFIX });
  if (!list.keys.length) return summary;
  let people = null;

  for (const { name: key } of list.keys) {
    const raw = await env.INTERCEDE_KV.get(key);
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch (_e) { continue; }
    summary.checked++;

    const now = localParts(rec.tz || "UTC");
    const due = toMinutes(ALERT_TIME);
    if (rec.lastSent === now.date || now.minutes < due || now.minutes > due + SEND_WINDOW_MIN) {
      summary.skipped++;
      continue;
    }

    if (!people) people = await loadPeople(env);
    const names = birthdaysOn(people, now);
    if (names.length === 0) {
      rec.lastSent = now.date; // nothing to send today; don't re-check until tomorrow
      await env.INTERCEDE_KV.put(key, JSON.stringify(rec));
      summary.skipped++;
      continue;
    }

    const result = await sendPush(rec, env, siteOrigin);
    if (result === "ok") {
      rec.lastSent = now.date;
      await env.INTERCEDE_KV.put(key, JSON.stringify(rec));
      summary.sent++;
    } else if (result === "gone") {
      await env.INTERCEDE_KV.delete(key);
      summary.removed++;
    } else {
      summary.errors++; // leave lastSent alone so the next tick retries
    }
  }
  return summary;
}

// ── Handler ──────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!env.INTERCEDE_KV) return json({ error: "KV not bound" }, 500);

  let body;
  try { body = await request.json(); } catch (_e) { return json({ error: "Invalid JSON" }, 400); }
  const siteOrigin = new URL(request.url).origin;
  const action = body.action;

  if (action === "run") {
    if (!env.CRON_SECRET || request.headers.get("x-cron-secret") !== env.CRON_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!env.VAPID_PRIVATE_KEY) return json({ error: "VAPID_PRIVATE_KEY is not set" }, 500);
    return json({ ok: true, ...(await runScheduled(env, siteOrigin)) });
  }

  if (action === "register") {
    const sub = body.subscription;
    if (!sub?.endpoint || !sub?.keys) return json({ error: "Invalid subscription" }, 400);
    let tz = body.tz || "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch (_e) { tz = "UTC"; }
    const key = PREFIX + await recordId(sub.endpoint);
    let prev = null;
    try { prev = JSON.parse(await env.INTERCEDE_KV.get(key)); } catch (_e) {}
    const rec = { subscription: sub, time: ALERT_TIME, tz, lastSent: prev?.lastSent || null, createdAt: prev?.createdAt || Date.now() };
    await env.INTERCEDE_KV.put(key, JSON.stringify(rec));
    return json({ ok: true });
  }

  if (!body.endpoint) return json({ error: "Missing endpoint" }, 400);
  const key = PREFIX + await recordId(body.endpoint);
  const raw = await env.INTERCEDE_KV.get(key);
  const rec = raw ? JSON.parse(raw) : null;

  if (action === "status") return json({ enabled: !!rec, time: rec?.time || null });

  if (action === "unregister") {
    await env.INTERCEDE_KV.delete(key);
    return json({ ok: true });
  }

  if (action === "test") {
    if (!rec) return json({ error: "This device isn't registered for birthday alerts." }, 404);
    if (!env.VAPID_PRIVATE_KEY) return json({ error: "VAPID_PRIVATE_KEY isn't set on the server yet." }, 500);
    rec.testPending = true;
    await env.INTERCEDE_KV.put(key, JSON.stringify(rec));
    const result = await sendPush(rec, env, siteOrigin);
    if (result === "gone") {
      await env.INTERCEDE_KV.delete(key);
      return json({ error: "This device's notification subscription expired. Turn alerts off and on again." }, 410);
    }
    if (result !== "ok") return json({ error: "The push service rejected the message. Check the VAPID keys." }, 502);
    return json({ ok: true });
  }

  if (action === "message") {
    // Called by the service worker after an empty push arrives.
    if (!rec) return json({});
    if (rec.testPending) {
      delete rec.testPending;
      await env.INTERCEDE_KV.put(key, JSON.stringify(rec));
      return json({ title: "🎂 Birthday alerts are working", body: `You'll get a notification at ${formatTime(rec.time)} on days when someone has a birthday.` });
    }
    const names = birthdaysOn(await loadPeople(env), localParts(rec.tz || "UTC"));
    return json(names.length ? buildMessage(names) : {});
  }

  return json({ error: "Unknown action" }, 400);
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

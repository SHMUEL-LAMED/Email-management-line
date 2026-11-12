import { G, H, SCOPES, esc, html, kvJson, logEvent, randKey, safeEq, sleep } from "./base.js";
import { NotConnected, gapi } from "./google.js";
import { bridge } from "./state.js";
import { nowIL } from "./assistant.js";
import { claudeEmailReply, claudeMails, mailCopyOfAnswer } from "./claude.js";

// ---------------------------------------------------------------- דפי אינטרנט

const PAGE = (title, body) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{--bg:#f6f5f2;--card:#fff;--ink:#1d2433;--mut:#667085;--acc:#1f6f5c;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--card:#1a1f26;--ink:#e6e8eb;--mut:#98a2b3;--acc:#4fb898;--bad:#f97066}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,"Segoe UI",Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px}.card{background:var(--card);border-radius:14px;padding:20px;margin:14px 0;box-shadow:0 1px 3px #0001}
h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:0 0 10px}.mut{color:var(--mut)}.ok{color:var(--acc);font-weight:600}.bad{color:var(--bad);font-weight:600}
a.btn{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600}
ul{padding-inline-start:18px;margin:0}li{margin:4px 0;font-size:14px}</style></head><body><main>${body}</main></body></html>`;

async function statusPage(env, url) {
  if (!(await safeEq(url.searchParams.get("k") || "", env.SETUP_KEY))) return html(PAGE("לא מורשה", `<div class="card"><h1>אין גישה</h1></div>`), 403);
  const email = await env.KV.get("g:email");
  const log = await kvJson(env, "log", []);
  const k = encodeURIComponent(env.SETUP_KEY);
  let conn;
  if (env.GOOGLE_SA_KEY || email) {
    const checks = await testConnection(env);
    conn = `<p class="mut">החשבון: ${esc(env.BUSINESS_EMAIL)}</p><ul>${checks.map((c) => `<li><span class="${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✗"} ${esc(c.name)}</span>${c.ok ? "" : ` <span class="mut">${esc(c.err)}</span>`}</li>`).join("")}</ul>`;
  } else {
    conn = email ? `<p class="ok">מחובר: ${esc(email)}</p><p><a class="btn" href="/connect?k=${k}">חיבור מחדש</a></p>` : `<p class="bad">עדיין לא מחובר</p><p><a class="btn" href="/connect?k=${k}">חיבור החשבון העסקי</a></p>`;
  }
  return html(PAGE("הקו שלי – מייל וצ'אט", `
<h1>הקו שלי – מייל וצ'אט</h1><p class="mut">ניהול המייל והצ'אט העסקי דרך הטלפון</p>
<div class="card"><h2>חיבור לחשבון גוגל</h2>${conn}</div>
<div class="card"><h2>יומן פעולות</h2>${log.length ? `<ul>${log.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="mut">עדיין אין פעולות</p>`}</div>`));
}

async function testConnection(env) {
  const out = [];
  const run = async (name, fn) => {
    try { await fn(); out.push({ name, ok: true }); }
    catch (e) { out.push({ name, ok: false, err: e instanceof NotConnected ? "עדיין אין הרשאה מגוגל (צריך לאשר במסוף הניהול)" : e.message }); }
  };
  await run("מייל (Gmail)", () => gapi(env, `${G.gmail}profile`));
  await run("צ'אט (Google Chat)", () => gapi(env, `${G.chat}spaces?pageSize=1`));
  await run("אנשי קשר", () => gapi(env, `${G.people}people/me/connections?personFields=names&pageSize=1`));
  return out;
}

async function connect(env, url) {
  if (!(await safeEq(url.searchParams.get("k") || "", env.SETUP_KEY))) return html(PAGE("לא מורשה", `<div class="card"><h1>אין גישה</h1></div>`), 403);
  const state = randKey(20);
  await env.KV.put("oauth_state:" + state, "1", { expirationTtl: 900 });
  const domain = String(env.BUSINESS_EMAIL || "").split("@")[1] || "";
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: url.origin + "/oauth/callback",
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (env.BUSINESS_EMAIL) p.set("login_hint", env.BUSINESS_EMAIL);
  if (domain) p.set("hd", domain);
  return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p, 302);
}

async function oauthCallback(env, url) {
  const state = url.searchParams.get("state") || "";
  if (!state || !(await env.KV.get("oauth_state:" + state))) return html(PAGE("שגיאה", `<div class="card"><h1 class="bad">הקישור פג תוקף</h1><p>יש להתחיל את החיבור מחדש.</p></div>`), 400);
  await env.KV.delete("oauth_state:" + state);
  if (url.searchParams.get("error")) return html(PAGE("בוטל", `<div class="card"><h1 class="bad">החיבור בוטל</h1><p class="mut">${esc(url.searchParams.get("error"))}</p></div>`), 400);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + "/oauth/callback", grant_type: "authorization_code" }),
  });
  const j = await r.json();
  if (!j.refresh_token) return html(PAGE("שגיאה", `<div class="card"><h1 class="bad">החיבור נכשל</h1><p class="mut">${esc(j.error_description || j.error || "לא התקבל אישור קבוע מגוגל")}</p></div>`), 400);
  const info = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + j.access_token } }).then((x) => x.json()).catch(() => ({}));
  const email = String(info.email || "").toLowerCase();
  if (env.BUSINESS_EMAIL && email !== env.BUSINESS_EMAIL.toLowerCase()) {
    return html(PAGE("חשבון לא נכון", `<div class="card"><h1 class="bad">התחברת לחשבון אחר</h1><p>התחברת עם ${esc(email)}. יש להתחבר עם המייל העסקי.</p></div>`), 400);
  }
  await env.KV.put("g:refresh", j.refresh_token);
  await env.KV.put("g:access", j.access_token, { expirationTtl: Math.max(60, (j.expires_in || 3600) - 300) });
  await env.KV.put("g:email", email);
  await env.KV.delete("g:me");
  await env.KV.delete("contacts");
  await logEvent(env, "חשבון גוגל חובר: " + email);
  return html(PAGE("מחובר", `<div class="card"><h1 class="ok">החשבון חובר בהצלחה</h1><p>אפשר להתקשר לקו ולהתחיל להשתמש.</p></div>`));
}

// ---- API לריצה המתוזמנת של Claude (מוגן במפתח BRIDGE_KEY)
// שקיעה בירושלים (חישוב אסטרונומי מקורב, דיוק של כמה דקות) – לזמני כניסת שבת וצאת שבת
function sunsetIL(d = new Date()) {
  const lat = 31.78, lng = 35.22, rad = Math.PI / 180;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  const jd = Date.UTC(+p.year, +p.month - 1, +p.day) / 86400e3 + 2440587.5; // יום יוליאני בחצות UTC
  const n = Math.ceil(jd - 2451545.0 + 0.0008);
  const Js = n - lng / 360;
  const M = ((357.5291 + 0.98560028 * Js) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const Jtr = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;
  return new Date((Jtr + H / 360 - 2440587.5) * 86400e3);
}
// שבת: מ-60 דקות לפני השקיעה ביום שישי, עד 50 דקות אחרי השקיעה במוצאי שבת
function isShabbatIL(d = new Date()) {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short" }).format(d);
  if (wd === "Fri") return d.getTime() >= sunsetIL(d).getTime() - 60 * 60e3;
  if (wd === "Sat") return d.getTime() < sunsetIL(d).getTime() + 50 * 60e3;
  return false;
}
async function bridgeApi(req, env, url) {
  const key = url.searchParams.get("k") || req.headers.get("x-bridge-key");
  if (!(await safeEq(key || "", env.BRIDGE_KEY))) return new Response("forbidden", { status: 403 });
  const op = url.pathname.split("/")[2];
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json; charset=utf-8" } });
  if (op === "peek") {
    let new_emails = 0;
    try { new_emails = (await claudeMails(env)).length; } catch (e) { await logEvent(env, "בדיקת מיילים לקלאוד נכשלה: " + e.message); }
    return J({ ...(await bridge(env, "peek")), new_emails, shabbat: isShabbatIL(), now_israel: nowIL() });
  }
  if (op === "emails") return J({ emails: await claudeMails(env) });
  if (op === "state") return J(await bridge(env, "state"));
  if (op === "email_reply") {
    if (!body.id || !body.text) return J({ error: "id או text חסרים" });
    const r = await claudeEmailReply(env, body.id, String(body.text));
    return J({ ok: true, id: r.id });
  }
  if (op === "take") return J(await bridge(env, "take"));
  if (op === "wait") {
    const until = Date.now() + Math.min(55, +url.searchParams.get("sec") || 50) * 1000;
    for (;;) {
      const r = await bridge(env, "take");
      if (r.messages.length || Date.now() > until) return J({ ...r, shabbat: isShabbatIL() });
      await sleep(2000);
    }
  }
  if (op === "answer") {
    if (!body.text) return J({ error: "text חסר" });
    const r = await bridge(env, "answer", { re: body.re, text: body.text, confirm: body.confirm || "" });
    await logEvent(env, "קלאוד ענה בקו: " + String(body.text).slice(0, 120));
    if (body.mail_copy !== false) {
      const q = body.re ? ((await bridge(env, "state")).msgs || []).find((m) => m.id === body.re)?.text || "" : "";
      await mailCopyOfAnswer(env, q, String(body.text));
    }
    return J(r);
  }
  if (op === "live") return J(await bridge(env, "live", { on: !!body.on }));
  return J({ error: "unknown" });
}

export { PAGE, statusPage, testConnection, connect, oauthCallback, sunsetIL, isShabbatIL, bridgeApi };

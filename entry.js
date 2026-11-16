import { gptMailboxApi } from "./gpt-mailbox.js";
// נקודת הכניסה שעולה ל-Cloudflare: כל הקו (worker.js) כמו שהוא, ובנוסף ה-API של אתר הצאט (chatsite.js)
// והשיחה עם Claude מאתר הצאט (chat/claude.html): ההודעות נכנסות לתור של הקו (kind "site"),
// והתשובות נשארות באתר – לא מוקראות בקו ולא נשלחות כעותק במייל.
import worker, { CallState as BaseCallState, safeEq } from "./worker.js";
import { chatSiteApi } from "./chatsite.js";
import { accessToken } from "./lib/google.js";
export * from "./worker.js";

const ORIGIN = "https://shmuel-lamed.github.io";

// קבצים שמועלים מהאתר ל-Claude: כל קובץ נשמר ב-KV בחלקים (cf:<מזהה>:<חלק>) לשלושה ימים,
// והריצה של Claude מורידה אותם דרך /bridge/file. עד 34 חלקים של 4 מגה לכל היותר (האתר שולח 3 מגה בחלק).
const UP_PART = 4 * 1024 * 1024, UP_PARTS = 34, UP_TTL = 3 * 86400;
const upId = (s) => String(s || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
// קבצים ש-Claude שולח לאתר: הריצה מעלה אותם בחלקים דרך /bridge/file_put (נשמרים ב-KV כ-co:<מזהה>:<חלק> לשבוע),
// מצרפת אותם לתשובה (files בבקשת answer), והאתר מוריד אותם דרך /chatsite/file?cf=<מזהה>.
const OUT_TTL = 7 * 86400;
const sizeLabel = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " מגה" : Math.max(1, Math.round(n / 1024)) + " ק״ב");
const outMark = (m) => "\n\n[קובץ מ-Claude: " + String(m.name).replace(/[\]\n|]/g, " ") + " | " + sizeLabel(m.size) + " | מזהה: " + m.id + " | חלקים: " + m.parts + "]";
const UP_HINT = "\n\n(לריצה של Claude – קובץ שהועלה מהאתר מורידים בחלקים: GET /bridge/file?id=<המזהה>&part=<מספר>, מ-0 עד מספר החלקים פחות אחת, ומחברים לפי הסדר. בלי part מתקבלים פרטי הקובץ. הקובץ נשמר שלושה ימים.)";

// ה-DO של הגשר: שתי פעולות נוספות מעל מה שיש ב-worker.js
export class CallState extends BaseCallState {
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const st = this.state.storage;
    if (path === "/bridge/site") {
      const msgs = (await st.get("msgs")) || [];
      const answers = (await st.get("answers")) || [];
      const live = (await st.get("live")) || { on: false, at: 0 };
      const mine = msgs.filter((m) => m.kind === "site").slice(-150);
      const conv = new Map(mine.map((m) => [m.id, m.conv || ""]));
      const items = [
        ...mine.map((m) => ({ id: m.id, from: "me", conv: m.conv || "", text: m.text, at: m.at, status: m.status })),
        ...answers.filter((a) => conv.has(a.re)).map((a) => ({ id: a.id, from: "claude", re: a.re, conv: conv.get(a.re), text: a.text, confirm: a.confirm || "", at: a.at })),
      ].sort((x, y) => x.at - y.at);
      return new Response(JSON.stringify({ items, live: live.on && Date.now() - live.at < 120e3 }));
    }
    if (path === "/bridge/siteadd") {
      // הודעה מהאתר בתוך שיחה מסוימת (conv): נכנסת לתור כרגיל, ומסומנת בשיחה שלה.
      // לריצה של Claude נשלחות גם ההודעות האחרונות מאותה שיחה, כדי שיבין את ההקשר.
      const b = await req.json().catch(() => ({}));
      const conv = String(b.conv || "").replace(/[^a-z0-9]/gi, "").slice(0, 24);
      const prevMsgs = (await st.get("msgs")) || [];
      const answers = (await st.get("answers")) || [];
      const plain = String(b.text || "").slice(0, 16000);
      let text = plain;
      if (conv) {
        // כל שיחה באתר עומדת בפני עצמה: הריצה מקבלת רק את ההודעות של השיחה הזו (עד 8 אחרונות, ועד 7,000 תווים)
        const earlier = prevMsgs.filter((m) => m.kind === "site" && m.conv === conv).slice(-8);
        if (earlier.length) {
          const ctx = earlier.map((m) => {
            const a = answers.find((x) => x.re === m.id);
            return "שמואל: " + String(m.text).slice(0, 500) + (a ? "\nClaude: " + String(a.text).slice(0, 700) : "");
          });
          while (ctx.length > 1 && ctx.join("\n").length > 7000) ctx.shift();
          text = text + "\n\n(הקשר – ההודעות הקודמות באותה שיחה באתר. זו שיחה נפרדת: ענה רק לפיה, ואל תערב בה דברים משיחות אחרות:\n" + ctx.join("\n") + ")";
        }
      }
      // קובץ שהועלה מהאתר (claude_upload): הריצה מקבלת גם הסבר איך להוריד אותו
      if (/\[קובץ שהועלה: /.test(plain)) text += UP_HINT;
      const res = await super.fetch(new Request("https://do/bridge/add", { method: "POST", body: JSON.stringify({ text: plain.slice(0, 200), kind: "site" }) }));
      const out = await res.json();
      const msgs = (await st.get("msgs")) || [];
      const m = msgs.find((x) => x.id === out.id);
      if (m) {
        // בתור נשמר עד 1,200 תווים (מגבלת גודל באחסון). הנוסח המלא – עם קבצים מצורפים והקשר – נשמר בנפרד עד שהריצה לוקחת אותו
        m.conv = conv; m.text = plain.slice(0, 1200);
        await st.put("msgs", msgs);
        if (text !== m.text) await st.put("sb:" + m.id, text.slice(0, 20000));
      }
      return new Response(JSON.stringify(out));
    }
    if (path === "/bridge/take") {
      const res = await super.fetch(req);
      const out = await res.json();
      const all = (await st.get("msgs")) || [];
      for (const m of out.messages || []) {
        if (m.kind !== "site") continue;
        // מזהה השיחה באתר, כדי שהריצה תדע אילו הודעות שייכות לאותה שיחה
        m.conv = all.find((x) => x.id === m.id)?.conv || "";
        const full = await st.get("sb:" + m.id);
        if (full) { m.text = full; await st.delete("sb:" + m.id); }
      }
      return new Response(JSON.stringify(out));
    }
    if (path === "/bridge/kind") {
      const b = await req.json().catch(() => ({}));
      const m = ((await st.get("msgs")) || []).find((x) => x.id === b.re);
      return new Response(JSON.stringify({ kind: m?.kind || "" }));
    }
    if (path === "/bridge/answer") {
      // תשובה להודעה מהאתר: מסומנת כ"נשמעה" כדי שהקו לא יקריא אותה
      const raw = await req.text();
      const res = await super.fetch(new Request(req.url, { method: "POST", body: raw }));
      const b = JSON.parse(raw || "{}");
      const msgs = (await st.get("msgs")) || [];
      if (b.re && msgs.some((m) => m.id === b.re && m.kind === "site")) {
        const answers = (await st.get("answers")) || [];
        const out = await res.clone().json().catch(() => ({}));
        const a = answers.find((x) => x.id === out.id);
        if (a) { a.heard = true; a.site = true; await st.put("answers", answers); }
      }
      return res;
    }
    return super.fetch(req);
  }
}

const bridgeDo = async (env, op, body) => {
  const r = await env.CALLS.get(env.CALLS.idFromName("claude-bridge")).fetch("https://do/bridge/" + op, { method: "POST", body: JSON.stringify(body || {}) });
  return r.json();
};
async function sha(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function claudeSiteApi(req, env, url) {
  const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "content-type, x-chat-token", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const tok = req.headers.get("x-chat-token") || "";
  if (!tok || !(await env.KV.get("cs:tok:" + (await sha(tok))))) return J({ error: "צריך להיכנס מחדש" }, 401);
  const op = url.pathname.split("/")[2];
  try {
    if (op === "claude_upload") {
      // חלק אחד של קובץ: הגוף הוא הבייטים עצמם, והפרטים בפרמטרים
      if (req.method !== "POST") return J({ error: "שיטה לא מורשית" }, 405);
      const q = url.searchParams, id = upId(q.get("id")), part = Number(q.get("part")), parts = Number(q.get("parts"));
      if (id.length < 8 || !Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > UP_PARTS || part < 0 || part >= parts) return J({ error: "בקשה לא תקינה" }, 400);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return J({ error: "הקובץ ריק" }, 400);
      if (buf.byteLength > UP_PART) return J({ error: "החלק גדול מדי" }, 413);
      await env.KV.put("cf:" + id + ":" + part, buf, { expirationTtl: UP_TTL });
      if (part === parts - 1) {
        const meta = { id, name: String(q.get("name") || "file").replace(/[\x00-\x1f]/g, " ").slice(0, 200), type: String(q.get("type") || "").slice(0, 100), size: Number(q.get("size")) || 0, parts, at: Date.now() };
        await env.KV.put("cf:" + id, JSON.stringify(meta), { expirationTtl: UP_TTL });
      }
      return J({ ok: true, id, part });
    }
    if (op === "claude_send") {
      const body = await req.json().catch(() => ({}));
      const text = String(body.text || "").trim();
      if (!text) return J({ error: "חסר טקסט" }, 400);
      // עד 16,000 תווים: כולל תוכן של קובצי טקסט שמצורפים מהאתר
      const r = await bridgeDo(env, "siteadd", { text: text.slice(0, 16000), conv: body.conv || "" });
      return J({ ok: true, id: r.id });
    }
    return J(await bridgeDo(env, "site"));
  } catch (e) {
    return J({ error: "שגיאה בשרת" }, 500);
  }
}

// הורדת קובץ ש-Claude שלח, מהאתר: בלי part – הפרטים, עם part – הבייטים של החלק. מוגן באסימון של האתר.
async function claudeFileOut(req, env, url) {
  const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "content-type, x-chat-token", "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin" };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const tok = req.headers.get("x-chat-token") || "";
  if (!tok || !(await env.KV.get("cs:tok:" + (await sha(tok))))) return J({ error: "צריך להיכנס מחדש" }, 401);
  const id = upId(url.searchParams.get("cf"));
  const meta = id ? await env.KV.get("co:" + id, "json") : null;
  if (!meta) return J({ error: "הקובץ כבר לא שמור (קבצים נשמרים שבוע)" }, 404);
  const p = url.searchParams.get("part");
  if (p == null) return J(meta);
  const n = Number(p);
  const buf = Number.isInteger(n) && n >= 0 && n < meta.parts ? await env.KV.get("co:" + id + ":" + n, "arrayBuffer") : null;
  if (!buf) return J({ error: "חלק מהקובץ לא נמצא" }, 404);
  return new Response(buf, { headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-store", ...cors } });
}

export default {
  ...worker,
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/chatsite/claude_send" || url.pathname === "/chatsite/claude_history" || url.pathname === "/chatsite/claude_upload") return claudeSiteApi(req, env, url);
    if (url.pathname === "/chatsite/file" && url.searchParams.has("cf")) return claudeFileOut(req, env, url);
    if (url.pathname === "/chatsite/gpt_send" || url.pathname === "/chatsite/gpt_history") return gptMailboxApi(req, env, url);
    if (url.pathname.startsWith("/chatsite/")) return chatSiteApi(req, env, url);
    // בדיקת המפתח קודם: בלי BRIDGE_KEY תקין לא קוראים כלום מהתור
    const bridgeKeyOk = async () => safeEq(url.searchParams.get("k") || req.headers.get("x-bridge-key") || "", env.BRIDGE_KEY);
    if (url.pathname === "/bridge/file") {
      // הורדת קובץ שהועלה מהאתר, לריצה של Claude: בלי part – הפרטים, עם part – הבייטים של החלק
      const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      if (!env.BRIDGE_KEY || !(await bridgeKeyOk())) return J({ error: "forbidden" }, 403);
      const id = upId(url.searchParams.get("id"));
      const meta = id ? await env.KV.get("cf:" + id, "json") : null;
      if (!meta) return J({ error: "הקובץ לא נמצא (או שעברו שלושה ימים)" }, 404);
      const p = url.searchParams.get("part");
      if (p == null) return J(meta);
      const n = Number(p);
      const buf = Number.isInteger(n) && n >= 0 && n < meta.parts ? await env.KV.get("cf:" + id + ":" + n, "arrayBuffer") : null;
      if (!buf) return J({ error: "החלק לא נמצא" }, 404);
      return new Response(buf, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
    }
    if (url.pathname === "/bridge/file_put") {
      // קובץ ש-Claude שולח לאתר: חלק אחד בכל בקשה (עד 4 מגה, מומלץ 3). הגוף הוא הבייטים, והפרטים בפרמטרים.
      const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      if (!env.BRIDGE_KEY || !(await bridgeKeyOk())) return J({ error: "forbidden" }, 403);
      if (req.method !== "POST") return J({ error: "שיטה לא מורשית" }, 405);
      const q = url.searchParams, id = upId(q.get("id")), part = Number(q.get("part") || 0), parts = Number(q.get("parts") || 1);
      if (id.length < 8 || !Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > UP_PARTS || part < 0 || part >= parts) return J({ error: "בקשה לא תקינה" }, 400);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return J({ error: "הקובץ ריק" }, 400);
      if (buf.byteLength > UP_PART) return J({ error: "החלק גדול מדי" }, 413);
      await env.KV.put("co:" + id + ":" + part, buf, { expirationTtl: OUT_TTL });
      if (part === parts - 1) {
        const meta = { id, name: String(q.get("name") || "file").replace(/[\x00-\x1f]/g, " ").slice(0, 200), type: String(q.get("type") || "").slice(0, 100), size: Number(q.get("size")) || buf.byteLength, parts, at: Date.now() };
        await env.KV.put("co:" + id, JSON.stringify(meta), { expirationTtl: OUT_TTL });
      }
      return J({ ok: true, id, part });
    }
    if (url.pathname === "/bridge/drive_session") {
      // העלאת קובץ גדול לדרייב מהריצה של Claude: כאן רק נפתחת העלאה מתמשכת (resumable) עם החיבור של הקו לגוגל,
      // והריצה שולחת את הבייטים ישירות לכתובת שחוזרת. הכתובת תקפה רק לקובץ האחד הזה.
      const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      if (!env.BRIDGE_KEY || !(await bridgeKeyOk())) return J({ error: "forbidden" }, 403);
      if (req.method !== "POST") return J({ error: "שיטה לא מורשית" }, 405);
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || "").replace(/[\x00-\x1f]/g, " ").trim().slice(0, 200), size = Number(b.size);
      if (!name || !Number.isInteger(size) || size < 1 || size > 500 * 1024 * 1024) return J({ error: "בקשה לא תקינה" }, 400);
      const mime = String(b.mime || "application/octet-stream").slice(0, 100);
      try {
        const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,webViewLink", {
          method: "POST",
          headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(size) },
          body: JSON.stringify({ name }),
        });
        const loc = r.headers.get("location");
        if (!r.ok || !loc) return J({ error: "הדרייב לא פתח העלאה (" + r.status + ")" }, 502);
        return J({ url: loc });
      } catch (e) {
        return J({ error: "אין חיבור לגוגל" }, 502);
      }
    }
    if (url.pathname === "/bridge/answer" && req.method === "POST" && env.CALLS && (await bridgeKeyOk())) {
      // תשובה לשיחה מהאתר: בלי עותק במייל
      const raw = await req.text();
      let b = {};
      try { b = JSON.parse(raw); } catch {}
      if (b.re && (await bridgeDo(env, "kind", { re: b.re })).kind === "site") b.mail_copy = false;
      // קבצים מצורפים לתשובה (files: מזהים שהועלו ב-file_put): נוספת שורה לכל קובץ, והאתר מציג אותה ככפתור הורדה
      if (Array.isArray(b.files) && b.files.length) {
        const miss = [];
        b.text = String(b.text || "").slice(0, 5000); // מקום לשורות הקבצים בתוך מגבלת התשובה
        for (const f of b.files.slice(0, 10)) {
          const meta = await env.KV.get("co:" + upId(f), "json");
          if (meta) b.text = String(b.text || "") + outMark(meta); else miss.push(f);
        }
        if (miss.length) return new Response(JSON.stringify({ error: "קובץ לא נמצא: " + miss.join(", ") }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
        delete b.files;
      }
      req = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(b) });
    }
    return worker.fetch(req, env, ctx);
  },
};

// נקודת הכניסה שעולה ל-Cloudflare: כל הקו (worker.js) כמו שהוא, ובנוסף ה-API של אתר הצאט (chatsite.js)
// והשיחה עם Claude מאתר הצאט (chat/claude.html): ההודעות נכנסות לתור של הקו (kind "site"),
// והתשובות נשארות באתר – לא מוקראות בקו ולא נשלחות כעותק במייל.
import worker, { CallState as BaseCallState } from "./worker.js";
import { chatSiteApi } from "./chatsite.js";
export * from "./worker.js";

const ORIGIN = "https://shmuel-lamed.github.io";

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
        const earlier = prevMsgs.filter((m) => m.kind === "site" && m.conv === conv).slice(-3);
        if (earlier.length) {
          const ctx = earlier.map((m) => {
            const a = answers.find((x) => x.re === m.id);
            return "שמואל: " + String(m.text).slice(0, 300) + (a ? "\nClaude: " + String(a.text).slice(0, 400) : "");
          }).join("\n");
          text = text + "\n\n(הקשר – ההודעות הקודמות באותה שיחה באתר:\n" + ctx + ")";
        }
      }
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
      for (const m of out.messages || []) {
        if (m.kind !== "site") continue;
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

export default {
  ...worker,
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/chatsite/claude_send" || url.pathname === "/chatsite/claude_history") return claudeSiteApi(req, env, url);
    if (url.pathname.startsWith("/chatsite/")) return chatSiteApi(req, env, url);
    if (url.pathname === "/bridge/answer" && req.method === "POST" && env.CALLS) {
      // תשובה לשיחה מהאתר: בלי עותק במייל
      const raw = await req.text();
      let b = {};
      try { b = JSON.parse(raw); } catch {}
      if (b.re && (await bridgeDo(env, "kind", { re: b.re })).kind === "site") b.mail_copy = false;
      req = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(b) });
    }
    return worker.fetch(req, env, ctx);
  },
};

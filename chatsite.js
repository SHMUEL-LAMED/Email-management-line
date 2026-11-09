// אתר הצאט (shmuel-lamed.github.io/chat) – ה-API שהאתר פונה אליו.
// מודול נפרד מ-worker.js: משתמש באותו KV ובאותו חיבור לגוגל (g:refresh / g:access), בלי הרשאות חדשות.
// כניסה עם הקוד הסודי של הקו; מקבלים אסימון לחודש (נשמר ב-KV רק כ-hash).
const CHAT = "https://chat.googleapis.com/v1/";
const PEOPLE = "https://people.googleapis.com/v1/";
const ORIGINS = ["https://shmuel-lamed.github.io"];

async function sha(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randKey(n = 32) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
}
async function kvJson(env, key, def) {
  try { const v = await env.KV.get(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
async function logEvent(env, line) {
  try {
    const l = await kvJson(env, "log", []);
    l.unshift(new Date().toISOString().slice(0, 16).replace("T", " ") + " | " + line);
    await env.KV.put("log", JSON.stringify(l.slice(0, 60)));
  } catch {}
}
class NotConnected extends Error { constructor() { super("not connected"); } }

// אותו מנגנון כמו ב-worker.js: אסימון גישה שמור ב-KV, ואם פג – חידוש עם ה-refresh token
async function accessToken(env) {
  const cached = await env.KV.get("g:access");
  if (cached) return cached;
  const refresh = await env.KV.get("g:refresh");
  if (!refresh) throw new NotConnected();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) {
    if (j.error === "invalid_grant") throw new NotConnected();
    throw new Error("token: " + (j.error || r.status));
  }
  await env.KV.put("g:access", j.access_token, { expirationTtl: Math.max(60, (j.expires_in || 3600) - 300) });
  return j.access_token;
}
async function gapi(env, url, opts = {}) {
  const tok = await accessToken(env);
  const r = await fetch(url, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + tok, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`google ${r.status}: ${j?.error?.message || ""}`.slice(0, 300)); e.status = r.status; throw e; }
  return j;
}
async function myUserId(env) {
  let me = await env.KV.get("g:me");
  if (me) return me;
  try { me = String((await gapi(env, `${PEOPLE}people/me?personFields=names`)).resourceName || "").replace("people/", ""); } catch {}
  if (me) await env.KV.put("g:me", me, { expirationTtl: 30 * 86400 });
  return me || "";
}
async function userName(env, userRes) {
  const id = String(userRes || "").replace(/^users\//, "");
  if (!id) return "משתתף";
  const c = await env.KV.get("name:" + id);
  if (c) return c;
  let n = "";
  try {
    const j = await gapi(env, `${PEOPLE}people/${id}?personFields=names,emailAddresses`);
    n = j.names?.[0]?.displayName || j.emailAddresses?.[0]?.value?.split("@")[0] || "";
  } catch {}
  if (n) await env.KV.put("name:" + id, n, { expirationTtl: 7 * 86400 });
  return n || "משתתף";
}
const isDM = (s) => s.spaceType === "DIRECT_MESSAGE" || s.type === "DM";
async function members(env, space) {
  const map = {};
  try {
    const j = await gapi(env, `${CHAT}${space}/members?pageSize=200`);
    for (const m of j.memberships || []) { const u = m.member; if (u?.name) map[u.name] = u.displayName || (u.email ? u.email.split("@")[0] : ""); }
  } catch {}
  return map;
}
async function readState(env, space) {
  try { return (await gapi(env, `${CHAT}users/me/${space}/spaceReadState`)).lastReadTime || "1970-01-01T00:00:00Z"; }
  catch { return "1970-01-01T00:00:00Z"; }
}
async function lastMessages(env, space, n, before = "") {
  const f = before ? "&filter=" + encodeURIComponent(`createTime < "${before}"`) : "";
  const j = await gapi(env, `${CHAT}${space}/messages?pageSize=${n}${f}&orderBy=${encodeURIComponent("createTime desc")}`);
  return (j.messages || []).reverse();
}
async function threadMessages(env, space, thread) {
  const f = encodeURIComponent(`thread.name = ${thread}`);
  const j = await gapi(env, `${CHAT}${space}/messages?pageSize=200&filter=${f}&orderBy=${encodeURIComponent("createTime asc")}`);
  return j.messages || [];
}
const threadOk = (space, t) => typeof t === "string" && t.startsWith(space + "/threads/") && /^spaces\/[\w-]+\/threads\/[\w-]+$/.test(t);
const msgOk = (space, m) => typeof m === "string" && m.startsWith(space + "/messages/") && /^spaces\/[\w-]+\/messages\/[\w.-]+$/.test(m);
const isoOk = (t) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(String(t || ""));
const emailOk = (e) => /^[^\s@"\\/]+@[^\s@"\\/]+\.[^\s@"\\/]+$/.test(String(e || "")) && String(e).length < 200;
// רק הודעה שאני כתבתי אפשר לתקן או למחוק מהאתר (מנהל קבוצה יכול בגוגל למחוק גם של אחרים – כאן לא)
async function ownMessage(env, name) {
  const [m, me] = await Promise.all([gapi(env, CHAT + name), myUserId(env)]);
  return !!me && m.sender?.name === "users/" + me;
}
const MAX_UPLOAD = 8 * 1024 * 1024;
function b64bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// העלאת קובץ לשיחה (כמו בהודעה קולית מהקו): מחזיר את האסימון שמצרפים להודעה
async function uploadAttachment(env, space, bytes, filename, type) {
  const b = "b" + randKey(12);
  const enc = new TextEncoder();
  const head = enc.encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename })}\r\n--${b}\r\nContent-Type: ${type}\r\n\r\n`);
  const tail = enc.encode(`\r\n--${b}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await fetch(`https://chat.googleapis.com/upload/v1/${space}/attachments:upload?uploadType=multipart`, {
    method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": `multipart/related; boundary=${b}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  const tok = j.attachmentDataRef?.attachmentUploadToken || j.attachmentUploadToken || "";
  if (!r.ok || !tok) throw new Error("chat upload " + r.status);
  return tok;
}
async function findPeople(env, q) {
  const out = new Map();
  const add = (p) => {
    const e = String(p?.emailAddresses?.[0]?.value || "").toLowerCase();
    if (e && !out.has(e)) out.set(e, { name: p.names?.[0]?.displayName || e.split("@")[0], email: e });
  };
  const mask = "readMask=names,emailAddresses&pageSize=10&query=" + encodeURIComponent(q);
  const [c, d, o] = await Promise.all([
    gapi(env, `${PEOPLE}people:searchContacts?${mask}`).catch(() => ({})),
    gapi(env, `${PEOPLE}people:searchDirectoryPeople?${mask}&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`).catch(() => ({})),
    gapi(env, `${PEOPLE}otherContacts:search?${mask}`).catch(() => ({})),
  ]);
  (c.results || []).forEach((r) => add(r.person));
  (d.people || []).forEach(add);
  (o.results || []).forEach((r) => add(r.person));
  return [...out.values()].slice(0, 12);
}
const markRead = (env, space) => gapi(env, `${CHAT}users/me/${space}/spaceReadState?updateMask=lastReadTime`, { method: "PATCH", body: { lastReadTime: new Date().toISOString() } });
async function summarize(env, text) {
  const system = "סכם בעברית, בקצרה ובנקודות, את השיחה הבאה מצאט: מה נדון, מה סוכם, ומה מחכה לתשובה ממני.";
  if (env.GEMINI_KEY) {
    for (const model of String(env.GEMINI_MODELS || "gemini-2.5-flash,gemini-2.0-flash").split(",").map((x) => x.trim()).filter(Boolean)) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: system + "\n\n" + text }] }], generationConfig: { maxOutputTokens: 800 } }),
        });
        const j = await r.json();
        const out = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
        if (out) return out;
      } catch {}
    }
  }
  if (!env.AI) return "לא ניתן לסכם כרגע.";
  const r = await env.AI.run(env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", { messages: [{ role: "system", content: system }, { role: "user", content: text }], max_tokens: 700 });
  return String(r?.response ?? r?.result?.response ?? "").trim() || "לא ניתן לסכם כרגע.";
}

export async function chatSiteApi(req, env, url) {
  const origin = req.headers.get("origin") || "";
  const cors = {
    "access-control-allow-origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "access-control-allow-headers": "content-type, x-chat-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const op = url.pathname.split("/")[2] || "";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const spaceOk = (s) => /^spaces\/[\w-]+$/.test(String(s || ""));
  try {
    if (op === "login") {
      // אותו מונה ניסיונות שגויים כמו בקו: 6 טעויות נועלות לשעה
      const fails = +(await env.KV.get("pinfails")) || 0;
      if (fails >= 6) return J({ error: "הכניסה חסומה לשעה בגלל ניסיונות שגויים" }, 429);
      const pinHash = (await env.KV.get("pin_hash")) || (await sha(env.PIN || ""));
      if (!env.PIN && !(await env.KV.get("pin_hash"))) return J({ error: "לא הוגדר קוד סודי" }, 503);
      if (!body.pin || (await sha(String(body.pin))) !== pinHash) {
        await env.KV.put("pinfails", String(fails + 1), { expirationTtl: 3600 });
        await logEvent(env, fails + 1 >= 6 ? "הקו והאתר ננעלו לשעה אחרי 6 קודים שגויים" : "קוד שגוי בכניסה לאתר הצאט");
        return J({ error: "קוד שגוי" }, 401);
      }
      await env.KV.delete("pinfails").catch(() => {});
      const tok = randKey(32);
      await env.KV.put("cs:tok:" + (await sha(tok)), "1", { expirationTtl: 30 * 86400 });
      await logEvent(env, "כניסה לאתר הצאט");
      return J({ token: tok });
    }
    const tok = req.headers.get("x-chat-token") || "";
    if (!tok || !(await env.KV.get("cs:tok:" + (await sha(tok))))) return J({ error: "צריך להיכנס מחדש" }, 401);
    if (op === "logout") { await env.KV.delete("cs:tok:" + (await sha(tok))); return J({ ok: true }); }

    if (op === "spaces") {
      const me = await myUserId(env);
      const mute = await kvJson(env, "mute", []);
      const j = await gapi(env, `${CHAT}spaces?pageSize=1000`);
      const spaces = (j.spaces || []).sort((a, b) => String(b.lastActiveTime || "").localeCompare(String(a.lastActiveTime || ""))).slice(0, 40);
      const list = await Promise.all(spaces.map(async (s) => {
        let title = s.displayName || "";
        if (isDM(s)) {
          const ck = "cs:title:" + s.name;
          title = (await env.KV.get(ck)) || "";
          if (!title) {
            title = Object.entries(await members(env, s.name)).find(([u]) => u !== "users/" + me)?.[1] || "";
            if (title) await env.KV.put(ck, title, { expirationTtl: 7 * 86400 });
          }
        }
        const lr = await readState(env, s.name);
        return { space: s.name, dm: isDM(s), title: title || (isDM(s) ? "איש קשר" : "קבוצה בלי שם"), last: s.lastActiveTime || "", unread: !!(s.lastActiveTime && s.lastActiveTime > lr), muted: mute.includes(s.name) };
      }));
      return J({ spaces: list });
    }
    if (op === "messages" || op === "thread") {
      const space = url.searchParams.get("space");
      if (!spaceOk(space)) return J({ error: "שיחה לא תקינה" }, 400);
      const thread = url.searchParams.get("thread") || "";
      if (op === "thread" && !threadOk(space, thread)) return J({ error: "שרשור לא תקין" }, 400);
      const before = url.searchParams.get("before") || "";
      if (before && !isoOk(before)) return J({ error: "זמן לא תקין" }, 400);
      const me = await myUserId(env);
      const PAGE = 80;
      // lastRead: עד איפה קראתי לפני הפתיחה, כדי שהאתר יסמן מאיפה ההודעות החדשות
      const [raw, names, lastRead] = await Promise.all([
        op === "thread" ? threadMessages(env, space, thread) : lastMessages(env, space, PAGE, before),
        members(env, space),
        op === "messages" && !before ? readState(env, space) : "",
      ]);
      // בתצוגה הראשית: רק הודעות פותחות, ולכל אחת מספר התגובות בשרשור
      const replies = {};
      if (op === "messages") for (const m of raw) if (m.threadReply && m.thread?.name) replies[m.thread.name] = (replies[m.thread.name] || 0) + 1;
      const msgs = [];
      for (const m of raw) {
        if (op === "messages" && m.threadReply) continue;
        const u = m.sender?.name || "";
        msgs.push({
          id: m.name || "", mine: u === "users/" + me, who: names[u] || (await userName(env, u)),
          text: String(m.text || m.formattedText || ""), at: m.createTime || "",
          edited: !!(m.lastUpdateTime && m.lastUpdateTime !== m.createTime && !m.deleteTime),
          thread: m.thread?.name || "", replies: replies[m.thread?.name] || 0,
          reacts: (m.emojiReactionSummaries || []).map((r) => ({ e: r.emoji?.unicode || (r.emoji?.customEmoji ? "🙂" : ""), n: r.reactionCount || 1 })).filter((r) => r.e),
          atts: (m.attachment || []).map((a) => ({ name: a.contentName || "קובץ", type: a.contentType || "", ref: a.attachmentDataRef?.resourceName || "", drive: a.driveDataRef?.driveFileId || "" })),
        });
      }
      // more: יש עוד הודעות ישנות יותר; oldest: מאיפה להמשיך לטעון אחורה
      return J({ messages: msgs, more: op === "messages" && raw.length >= PAGE, oldest: raw[0]?.createTime || "", lastRead: lastRead || "" });
    }
    if (op === "file") {
      // הורדת קובץ שצורף בצאט (דרך ה-API של גוגל, עם אותו חיבור)
      const ref = url.searchParams.get("ref") || "";
      if (!ref || ref.length > 3000 || ref.includes("..")) return J({ error: "קובץ לא תקין" }, 400);
      const name = String(url.searchParams.get("name") || "file").replace(/["\r\n]/g, "").slice(0, 150);
      const tok2 = await accessToken(env);
      const r = await fetch(`${CHAT}media/${ref}?alt=media`, { headers: { Authorization: "Bearer " + tok2 } });
      if (!r.ok) return J({ error: "לא הצלחתי להוריד את הקובץ" }, 502);
      return new Response(r.body, { headers: { ...cors, "content-type": r.headers.get("content-type") || "application/octet-stream", "content-disposition": "inline; filename*=UTF-8''" + encodeURIComponent(name), "cache-control": "no-store" } });
    }
    if (op === "send") {
      const file = body.file && typeof body.file === "object" ? body.file : null;
      if (!spaceOk(body.space) || (!String(body.text || "").trim() && !file)) return J({ error: "חסר טקסט או שיחה" }, 400);
      if (body.thread && !threadOk(body.space, body.thread)) return J({ error: "שרשור לא תקין" }, 400);
      const msg = { text: String(body.text || "").slice(0, 4000) };
      if (file) {
        // קובץ מצורף מגיע כ-base64 בתוך ה-JSON (כך הוא עובר גם דרך הגשר)
        const data = String(file.data || "");
        if (!data || !/^[A-Za-z0-9+/]+=*$/.test(data)) return J({ error: "קובץ לא תקין" }, 400);
        if (data.length > MAX_UPLOAD * 4 / 3 + 8) return J({ error: "הקובץ גדול מדי (עד 8 מגה)" }, 413);
        const fname = String(file.name || "file").replace(/[\\/"\r\n\0]/g, "").slice(0, 150) || "file";
        const ftype = /^[\w.+-]+\/[\w.+-]+$/.test(String(file.type || "")) ? String(file.type) : "application/octet-stream";
        msg.attachment = [{ attachmentDataRef: { attachmentUploadToken: await uploadAttachment(env, body.space, b64bytes(data), fname, ftype) } }];
      }
      if (body.thread) msg.thread = { name: body.thread };
      const r = await gapi(env, `${CHAT}${body.space}/messages` + (body.thread ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : ""), { body: msg });
      await markRead(env, body.space).catch(() => {});
      return J({ ok: true, id: r.name || "" });
    }
    if (op === "react") {
      // לחיצה על אמוג'י: מוסיף תגובה, ואם כבר הגבתי באותו אמוג'י – מסיר אותה
      const emoji = String(body.emoji || "");
      if (!spaceOk(body.space) || !msgOk(body.space, body.id)) return J({ error: "הודעה לא תקינה" }, 400);
      if (!emoji || emoji.length > 16 || /[\w\s"\\]/.test(emoji)) return J({ error: "אמוג'י לא תקין" }, 400);
      try {
        await gapi(env, `${CHAT}${body.id}/reactions`, { body: { emoji: { unicode: emoji } } });
        return J({ ok: true, on: true });
      } catch (e) {
        if (e.status !== 409) throw e;
        const f = encodeURIComponent(`emoji.unicode = "${emoji}" AND user.name = "users/${await myUserId(env)}"`);
        const mine = (await gapi(env, `${CHAT}${body.id}/reactions?filter=${f}`)).reactions || [];
        for (const r of mine) if (r.name) await gapi(env, CHAT + r.name, { method: "DELETE" });
        return J({ ok: true, on: false });
      }
    }
    if (op === "edit" || op === "delete") {
      if (!spaceOk(body.space) || !msgOk(body.space, body.id)) return J({ error: "הודעה לא תקינה" }, 400);
      if (op === "edit" && !String(body.text || "").trim()) return J({ error: "חסר טקסט" }, 400);
      if (!(await ownMessage(env, body.id))) return J({ error: "אפשר לשנות רק הודעה שלך" }, 403);
      if (op === "edit") await gapi(env, `${CHAT}${body.id}?updateMask=text`, { method: "PATCH", body: { text: String(body.text).slice(0, 4000) } });
      else await gapi(env, CHAT + body.id, { method: "DELETE" });
      await logEvent(env, op === "edit" ? "הודעת צאט תוקנה מהאתר" : "הודעת צאט נמחקה מהאתר");
      return J({ ok: true });
    }
    if (op === "people") {
      // חיפוש אדם כדי לפתוח איתו שיחה פרטית
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
      if (q.length < 2) return J({ people: [] });
      return J({ people: await findPeople(env, q) });
    }
    if (op === "dm") {
      // שיחה פרטית עם אדם: הקיימת אם יש, ואם אין – נפתחת חדשה
      const email = String(body.email || "").trim().toLowerCase();
      if (!emailOk(email)) return J({ error: "כתובת לא תקינה" }, 400);
      let space = "";
      try { space = (await gapi(env, `${CHAT}spaces:findDirectMessage?name=${encodeURIComponent("users/" + email)}`)).name || ""; }
      catch (e) { if (e.status !== 404) throw e; }
      if (!space) {
        space = (await gapi(env, `${CHAT}spaces:setup`, { body: { space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: "users/" + email, type: "HUMAN" } }] } })).name || "";
        await logEvent(env, "נפתחה שיחת צאט חדשה מהאתר עם " + email);
      }
      if (!spaceOk(space)) return J({ error: "לא הצלחתי לפתוח שיחה" }, 502);
      // השם שכבר שמור לשיחה קודם; אחרת השם מהחיפוש
      let title = (await env.KV.get("cs:title:" + space)) || "";
      if (!title) {
        title = String(body.name || "").replace(/[\r\n]/g, " ").trim().slice(0, 80) || email.split("@")[0];
        await env.KV.put("cs:title:" + space, title, { expirationTtl: 7 * 86400 });
      }
      return J({ space, title, dm: true });
    }
    if (op === "read") {
      if (!spaceOk(body.space)) return J({ error: "שיחה לא תקינה" }, 400);
      await markRead(env, body.space);
      return J({ ok: true });
    }
    if (op === "mute") {
      if (!spaceOk(body.space)) return J({ error: "שיחה לא תקינה" }, 400);
      const mute = (await kvJson(env, "mute", [])).filter((x) => x !== body.space);
      if (body.on) mute.push(body.space);
      await env.KV.put("mute", JSON.stringify(mute));
      return J({ ok: true, muted: !!body.on });
    }
    if (op === "summary") {
      if (!spaceOk(body.space)) return J({ error: "שיחה לא תקינה" }, 400);
      const [raw, names] = await Promise.all([lastMessages(env, body.space, 50), members(env, body.space)]);
      const lines = [];
      for (const m of raw) lines.push(`${names[m.sender?.name] || (await userName(env, m.sender?.name))}: ${m.text || (m.attachment?.length ? "(קובץ מצורף)" : "")}`);
      if (!lines.length) return J({ summary: "אין הודעות בשיחה." });
      return J({ summary: await summarize(env, lines.join("\n").slice(-12000)) });
    }
    return J({ error: "unknown" }, 404);
  } catch (e) {
    if (e instanceof NotConnected) return J({ error: "החשבון של גוגל לא מחובר לקו" }, 503);
    await logEvent(env, "שגיאה באתר הצאט: " + String(e.message || e).slice(0, 150));
    return J({ error: "שגיאה בשרת" }, 500);
  }
}

import { G, MAX_CHAT_SPACES, YM, b64, b64url, decodeBody, html, kvJson, logEvent, randKey, sha, trimText, utf8b64 } from "./base.js";
import { attsOf } from "./menus.js";
import { bump } from "./voice.js";

// ---------------------------------------------------------------- ימות API

async function ym(env, method, params = {}) {
  const u = new URL(YM + method);
  u.searchParams.set("token", env.YM_TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (method === "DownloadFile") return new Uint8Array(await r.arrayBuffer());
  return r.json();
}

// ---------------------------------------------------------------- AI: תמלול וסיכום

// מודל שהחזיר "חריגה ממכסה" (429) מדלגים עליו לדקה, כדי לא לבזבז זמן
const geminiBusy = new Map();
const isBusy = (m) => (geminiBusy.get(m) || 0) > Date.now();
const markBusy = (m, j) => { if (j?.error?.code === 429 || j?.error?.code === 503) geminiBusy.set(m, Date.now() + 60e3); };
async function geminiCall(env, parts, maxTokens = 800, deadline = Date.now() + 20000) {
  const all = (env.GEMINI_MODELS || "gemini-flash-lite-latest,gemini-flash-latest").split(",").map((s) => s.trim());
  const models = all.filter((m) => !isBusy(m)).concat(all.filter(isBusy));
  let last = "";
  for (const m of models) {
    const left = deadline - Date.now();
    if (left < 1500) { last = last || "timeout"; break; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 } }),
        signal: AbortSignal.timeout(Math.min(15000, left)),
      });
      const j = await r.json();
      const out = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      bump(env, "gemini");
      if (out) return out;
      markBusy(m, j);
      if (j?.error?.code === 429) bump(env, "quota");
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) { last = e.message; if (e.name === "TimeoutError") geminiBusy.set(m, Date.now() + 60e3); }
  }
  throw new Error("gemini: " + last);
}

// שמות אנשי הקשר, כרמז לתמלול (משפר מאוד זיהוי שמות). מטמון ל-6 שעות.
async function nameHints(env) {
  const c = await kvJson(env, "namehints");
  if (c && Date.now() - c.t < 6 * 3600e3) return c.s;
  let s = "";
  try {
    const book = await contactBook(env);
    const order = { c: 0, d: 1, o: 2 };
    const names = [...new Set(book.slice().sort((a, b) => order[a.s] - order[b.s]).map((x) => x.n).filter((n) => n && !n.includes("@") && /\p{L}/u.test(n)))];
    s = names.slice(0, 300).join(", ");
  } catch {}
  await env.KV.put("namehints", JSON.stringify({ t: Date.now(), s }));
  return s;
}

// מה המשתמש אמר, לפי ההקשר: assistant = בקשה לעוזר, name = שם של איש קשר, message = הכתבת הודעה
const STT_CONTEXT = {
  assistant: "המשתמש מדבר עם העוזר האישי שלו ומבקש בקשה או פעולה הקשורה למייל, לצאט, ליומן, למשימות, לדרייב או לאנשי הקשר.",
  name: "המשתמש אומר שם של אדם (איש קשר) שאליו הוא רוצה לשלוח הודעה.",
  message: "המשתמש מכתיב תוכן של הודעה או מייל שהוא רוצה לשלוח.",
  document: "המשתמש מכתיב טקסט ארוך למסמך (או מקליט שיעור או פגישה). כתוב את התמלול עם פיסוק וחלוקה לפסקאות, בלי לקצר.",
  nav: "המשתמש אומר לאן הוא רוצה להגיע בתפריט של הקו, או מה לחפש (מייל, צאט, קבוצה, איש קשר, מספר טלפון).",
  command: "המשתמש אומר פקודה קצרה לבוט או שם של קובץ, קבוצה או אדם.",
};
async function transcribe(env, bytes, mode = "assistant") {
  bump(env, "stt");
  const hints = await nameHints(env).catch(() => "");
  if (env.GEMINI_KEY) {
    try {
      const t = await geminiCall(env, [
        { text: `זו הקלטה מהטלפון (איכות שמע נמוכה) בעברית. ${STT_CONTEXT[mode] || ""}
${hints ? `שמות של אנשים שהמשתמש מכיר ועשויים להיאמר (אם נשמע שם דומה, כתוב אותו בדיוק כמו ברשימה): ${hints}.` : ""}
תמלל את ההקלטה מילה במילה בעברית. אם נאמרה מילה באנגלית, כתוב אותה כמו שנאמרה. החזר רק את הטקסט שנאמר, בלי הקדמות. אם לא נאמר כלום, החזר מחרוזת ריקה.` },
        { inline_data: { mime_type: "audio/wav", data: b64(bytes) } },
      ], 1500);
      if (t) {
        const out = t.replace(/^["']|["']$/g, "").trim();
        // המודל לפעמים כותב במילים שלא נאמר כלום, במקום להחזיר ריק
        if (/^[\(\[]?(שקט|אין דיבור|לא נאמר|לא נשמע|אין קול|רעש בלבד|ריק|מחרוזת ריקה|\(ריק\))/.test(out) || !/[\p{L}\p{N}]/u.test(out)) return "";
        return out;
      }
    } catch (e) { await logEvent(env, "שגיאת תמלול Gemini: " + e.message); }
  }
  bump(env, "cf");
  const r = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: b64(bytes), language: "he", ...(hints ? { initial_prompt: hints.slice(0, 600) } : {}) });
  return String(r?.text || "").trim();
}

async function llm(env, system, user, maxTokens = 700) {
  if (env.GEMINI_KEY) {
    try { return await geminiCall(env, [{ text: system + "\n\n" + user }], maxTokens); }
    catch (e) { await logEvent(env, "שגיאת Gemini: " + e.message); }
  }
  const r = await env.AI.run(env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: maxTokens,
  });
  return String(r?.response ?? r?.result?.response ?? "").trim();
}

const SPOKEN = "כתוב בעברית פשוטה, במשפטים קצרים שמתאימים להקראה בטלפון. בלי רשימות, בלי כוכביות, בלי סימנים מיוחדים ובלי אימוג'י.";

// האם הטקסט בעיקר בשפה זרה (לא עברית)
function isForeign(t) {
  t = String(t).slice(0, 1200); // ההתחלה מכריעה: הצהרה משפטית באנגלית בסוף מייל עברי לא הופכת אותו ל"אנגלי"
  const he = (t.match(/[א-ת]/g) || []).length;
  const other = (t.match(/[A-Za-zÀ-ɏЀ-ӿ؀-ۿ]/g) || []).length;
  return other >= 15 && other > he * 1.5;
}
// תרגום לעברית להקראה (עם מטמון). שמות באנגלית נכתבים באותיות עבריות.
async function toHebrew(env, t, maxTokens = 1500) {
  if (!t || !isForeign(t)) return t;
  const key = "tr:" + (await sha(t)).slice(0, 32);
  const c = await env.KV.get(key);
  if (c) return c;
  try {
    const out = await llm(env,
      "תרגם את הטקסט הבא לעברית טבעית וברורה שמתאימה להקראה בטלפון. שמות של אנשים, חברות ומוצרים כתוב באותיות עבריות לפי ההגייה. שמור על המבנה, ואם יש שורות שמתחילות במילים מאת, נושא או תוכן, השאר את המילים האלה כמו שהן. החזר רק את התרגום, בלי הקדמות.",
      t, maxTokens);
    if (out) { await env.KV.put(key, out, { expirationTtl: 7 * 86400 }); return out; }
  } catch (e) { await logEvent(env, "שגיאת תרגום: " + e.message); }
  return t;
}

// ---------------------------------------------------------------- Google OAuth

// הרשאות לחשבון שירות עם האצלה בכל הדומיין (Domain-wide delegation)
const DWD_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.spaces.create",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  "https://www.googleapis.com/auth/chat.users.readstate",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
];
async function saToken(env) {
  const sa = JSON.parse(env.GOOGLE_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(JSON.stringify(o));
  // רשימת ההרשאות חייבת להתאים בדיוק למה שאושר למזהה הלקוח במסוף הניהול. ברירת המחדל מכסה מייל, צאט ואנשי קשר בלבד;
  // ליומן, דרייב, משימות ומסמכים דרך חשבון שירות מגדירים DWD_SCOPES (מופרד בפסיקים) ומאשרים את אותה רשימה במסוף
  const scopes = String(env.DWD_SCOPES || "").split(",").map((x) => x.trim()).filter(Boolean);
  const input = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: sa.client_email, sub: env.BUSINESS_EMAIL, scope: (scopes.length ? scopes : DWD_SCOPES).join(" "),
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  });
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  const jwt = input + "." + b64(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) {
    await logEvent(env, "קבלת הרשאה מגוגל נכשלה: " + (j.error_description || j.error || r.status));
    if (j.error === "unauthorized_client" || j.error === "access_denied") throw new NotConnected();
    throw new Error("sa token: " + (j.error || r.status));
  }
  await env.KV.put("g:access", j.access_token, { expirationTtl: Math.max(60, (j.expires_in || 3600) - 300) });
  return j.access_token;
}

async function accessToken(env) {
  const cached = await env.KV.get("g:access");
  if (cached) return cached;
  const refresh = await env.KV.get("g:refresh");
  if (!refresh && env.GOOGLE_SA_KEY) return saToken(env);
  if (!refresh) throw new NotConnected();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) {
    await logEvent(env, "חידוש החיבור לגוגל נכשל: " + (j.error || r.status));
    if (j.error === "invalid_grant") throw new NotConnected();
    throw new Error("token: " + (j.error || r.status));
  }
  await env.KV.put("g:access", j.access_token, { expirationTtl: Math.max(60, (j.expires_in || 3600) - 300) });
  return j.access_token;
}
class NotConnected extends Error { constructor() { super("not connected"); } }

async function gapi(env, url, opts = {}) {
  const tok = await accessToken(env);
  const r = await fetch(url, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + tok, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`google ${r.status}: ${j?.error?.message || ""}`.slice(0, 300));
    e.status = r.status;
    throw e;
  }
  return j;
}

// ---------------------------------------------------------------- Gmail

function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}
function parseAddr(v) {
  const m = String(v || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2].split("@")[0], email: m[2].trim() };
  const e = String(v || "").trim();
  return { name: e.split("@")[0], email: e };
}
function htmlToText(h) {
  return String(h)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&(rsquo|lsquo|rdquo|ldquo|hellip|ndash|mdash|copy|trade|shy|zwnj|zwj|lrm|rlm);/g, (_, n) => ({ rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", ndash: "–", mdash: "—", copy: "©", trade: "™" }[n] || ""))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}
function bodyOf(payload) {
  let plain = "", htm = "";
  const walk = (p) => {
    if (!p) return;
    const cs = (p.headers || []).find((h) => h.name.toLowerCase() === "content-type")?.value?.match(/charset="?([\w-]+)/i)?.[1];
    if (p.mimeType === "text/plain" && p.body?.data && !plain.trim()) plain = decodeBody(p.body.data, cs);
    else if (p.mimeType === "text/html" && p.body?.data && !htm.trim()) htm = decodeBody(p.body.data, cs);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  let t = plain.trim() ? plain : htmlToText(htm);
  // הסרת ציטוט של מייל קודם (גם כותרות ציטוט בעברית של Gmail ו-Outlook)
  const cut = t.search(/\n\s*(On .{5,120}wrote:|ב.{3,120}נכתב:|ב.{3,120}כתב\/ה:|\u202b?בתאריך .{5,200}מאת .{1,160}:|מאת: .+\n.*נשלח:|-{3,}\s*Original Message|-{3,}\s*Forwarded message|From: .+\n.*(Sent|Date):)/i);
  if (cut > 40) t = t.slice(0, cut);
  t = t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n");
  return t.replace(/\n{2,}/g, "\n").trim();
}
const MAIL_CATS = { primary: "category:primary", updates: "category:updates" };
const CAT_NAME = { primary: "התיבה הראשית", updates: "העדכונים" };
async function gmailUnread(env, max = 25, cat = "primary") {
  const q = encodeURIComponent("in:inbox is:unread " + (MAIL_CATS[cat] || ""));
  const j = await gapi(env, `${G.gmail}messages?q=${q}&maxResults=${max}`);
  return (j.messages || []).map((m) => m.id);
}
async function gmailGet(env, id) {
  const m = await gapi(env, `${G.gmail}messages/${id}?format=full`);
  const from = parseAddr(header(m, "From"));
  const replyTo = header(m, "Reply-To");
  return {
    id, threadId: m.threadId,
    fromName: from.name, fromEmail: from.email,
    replyTo: replyTo ? parseAddr(replyTo).email : from.email,
    subject: header(m, "Subject") || "ללא נושא",
    msgId: header(m, "Message-ID") || header(m, "Message-Id"),
    refs: header(m, "References"),
    snippet: m.snippet || "",
    to: header(m, "To"), date: header(m, "Date"),
    body: trimText(bodyOf(m.payload) || m.snippet || "", 6000),
    attachments: countAttachments(m.payload),
  };
}
// תמונה משובצת (חתימה) ולא קובץ מצורף אמיתי: Content-Disposition inline + Content-ID
const isInlineImage = (x) => /^image\//.test(x.mimeType || "") && (x.headers || []).some((h) => h.name.toLowerCase() === "content-id") && (x.headers || []).some((h) => h.name.toLowerCase() === "content-disposition" && /^\s*inline/i.test(h.value));
function countAttachments(p) {
  let n = 0;
  const walk = (x) => { if (!x) return; if (x.filename && x.body?.attachmentId && !isInlineImage(x)) n++; (x.parts || []).forEach(walk); };
  walk(p);
  return n;
}
async function gmailMarkRead(env, id) {
  await gapi(env, `${G.gmail}messages/${id}/modify`, { body: { removeLabelIds: ["UNREAD"] } });
}
const encHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${utf8b64(s)}?=`;
const wrap76 = (s) => s.replace(/(.{76})/g, "$1\r\n");
async function gmailSend(env, { to, subject, body, threadId, inReplyTo, refs, att, cc, html }) {
  const lines = [`To: ${to}`, cc ? `Cc: ${cc}` : "", `Subject: ${encHeader(subject)}`, "MIME-Version: 1.0"].filter(Boolean);
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${(refs ? refs + " " : "") + inReplyTo}`);
  }
  let raw;
  if (att) {
    const b = "m" + randKey(16);
    lines.push(`Content-Type: multipart/mixed; boundary="${b}"`);
    raw = lines.join("\r\n") + "\r\n\r\n" + [`--${b}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(utf8b64(body)),
      `--${b}`, `Content-Type: ${att.mime || "application/octet-stream"}; name="${encHeader(att.name)}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${encHeader(att.name)}"`, "", wrap76(b64(att.bytes)), `--${b}--`, ""].join("\r\n");
  } else if (html) {
    // טקסט רגיל + גרסה מעוצבת (HTML); תוכנת המייל מציגה את המעוצבת
    const b = "a" + randKey(16);
    lines.push(`Content-Type: multipart/alternative; boundary="${b}"`);
    raw = lines.join("\r\n") + "\r\n\r\n" + [`--${b}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(utf8b64(body)),
      `--${b}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", wrap76(utf8b64(html)), `--${b}--`, ""].join("\r\n");
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    raw = lines.join("\r\n") + "\r\n\r\n" + wrap76(utf8b64(body));
  }
  const payload = { raw: b64url(raw) };
  if (threadId) payload.threadId = threadId;
  return gapi(env, `${G.gmail}messages/send`, { body: payload });
}

// ---------------------------------------------------------------- אנשים

async function myUserId(env) {
  let me = await env.KV.get("g:me");
  if (me) return me;
  // המזהה שלי בצאט (users/<id>) הוא מזהה האדם ב-People API. people/me הוא הדרך הבטוחה; חיפוש בספרייה רק כגיבוי
  try { me = String((await gapi(env, `${G.people}people/me?personFields=names`)).resourceName || "").replace("people/", ""); } catch {}
  if (!me) {
    const mail = String(env.BUSINESS_EMAIL || "").toLowerCase();
    const j = await gapi(env, `${G.people}people:searchDirectoryPeople?query=${encodeURIComponent(mail.split("@")[0])}&readMask=emailAddresses&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`);
    const people = j.people || [];
    // רק התאמה מדויקת לפי הכתובת (people[0] יכול להיות אדם אחר עם קידומת דומה, ואז ההודעות שלי נקראות כחדשות)
    const p = people.find((x) => (x.emailAddresses || []).some((e) => String(e.value).toLowerCase() === mail));
    me = String(p?.resourceName || "").replace("people/", "");
  }
  if (me) await env.KV.put("g:me", me, { expirationTtl: 30 * 86400 });
  return me;
}
async function userName(env, userRes) {
  const id = String(userRes || "").replace(/^users\//, "");
  if (!id) return "משתתף";
  const k = "name:" + id;
  const c = await env.KV.get(k);
  if (c) return c;
  let n = "";
  try {
    const j = await gapi(env, `${G.people}people/${id}?personFields=names,emailAddresses`);
    n = j.names?.[0]?.displayName || j.emailAddresses?.[0]?.value?.split("@")[0] || "";
  } catch {}
  if (n) await env.KV.put(k, n, { expirationTtl: 86400 * 7 });
  return n || "משתתף";
}

// רשימת אנשי קשר (מטמון ל-6 שעות): שם + מייל
async function contactBook(env) {
  const c = await kvJson(env, "contacts");
  if (c && Date.now() - c.t < 6 * 3600e3) return c.list;
  const list = [];
  let failed = false;
  const add = (p, src) => {
    const name = p.names?.[0]?.displayName || "";
    for (const e of p.emailAddresses || []) if (e.value) list.push({ n: name || e.value.split("@")[0], e: e.value, s: src });
  };
  try {
    let tok = "";
    for (let i = 0; i < 3; i++) {
      const j = await gapi(env, `${G.people}people/me/connections?personFields=names,emailAddresses&pageSize=1000${tok ? "&pageToken=" + tok : ""}`);
      (j.connections || []).forEach((p) => add(p, "c"));
      if (!(tok = j.nextPageToken)) break;
    }
  } catch (e) { failed = true; if (e instanceof NotConnected) throw e; }
  try {
    let tok = "";
    for (let i = 0; i < 3; i++) {
      const j = await gapi(env, `${G.people}people:listDirectoryPeople?readMask=names,emailAddresses&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&pageSize=1000${tok ? "&pageToken=" + tok : ""}`);
      (j.people || []).forEach((p) => add(p, "d"));
      if (!(tok = j.nextPageToken)) break;
    }
  } catch { failed = true; }
  try {
    let tok = "";
    for (let i = 0; i < 2; i++) {
      const j = await gapi(env, `${G.people}otherContacts?readMask=names,emailAddresses&pageSize=1000${tok ? "&pageToken=" + tok : ""}`);
      (j.otherContacts || []).forEach((p) => add(p, "o"));
      if (!(tok = j.nextPageToken)) break;
    }
  } catch { failed = true; }
  const seen = new Set();
  const dedup = list.filter((x) => { const k = x.e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  // רשימה ריקה בגלל תקלה זמנית לא נשמרת במטמון (אחרת שש שעות "לא מצאתי איש קשר")
  if (dedup.length || !failed) await env.KV.put("contacts", JSON.stringify({ t: Date.now(), list: dedup }));
  return dedup;
}

const normName = (s) => String(s || "").toLowerCase().replace(/[֑-ׇ]/g, "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

// חיפוש איש קשר לפי שם שנאמר בטלפון
async function findPeople(env, spoken) {
  const book = await contactBook(env);
  let variants = [spoken];
  try {
    const out = await llm(env,
      "אתה עוזר לחפש איש קשר. קיבלת שם שנאמר בעברית בטלפון (ייתכנו שגיאות תמלול). החזר עד 6 צורות כתיב אפשריות של השם, בעברית ובאנגלית (תעתיק), כל אחת בשורה נפרדת, בלי מספור ובלי הסברים.",
      spoken, 120);
    variants = variants.concat(out.split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {}
  const vs = [...new Set(variants.map(normName).filter((v) => v.length >= 2))];
  const scored = [];
  for (const c of book) {
    const n = normName(c.n), e = c.e.toLowerCase().split("@")[0];
    let best = 0;
    for (const v of vs) {
      const words = v.split(" ");
      if (n === v) best = Math.max(best, 100);
      else if (n.includes(v)) best = Math.max(best, 80);
      else {
        const hit = words.filter((w) => w.length >= 2 && (n.split(" ").some((x) => x.startsWith(w)) || e.includes(w))).length;
        if (hit) best = Math.max(best, 40 + (hit / words.length) * 30);
      }
    }
    if (best) scored.push({ ...c, score: best + (c.s === "c" ? 5 : c.s === "d" ? 3 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// ---------------------------------------------------------------- Google Chat

const isDM = (s) => s.spaceType === "DIRECT_MESSAGE" || s.type === "DM";
const isGroup = (s) => !isDM(s);

async function chatSpaces(env) {
  let all = [], tok = "";
  for (let i = 0; i < 2; i++) {
    const j = await gapi(env, `${G.chat}spaces?pageSize=1000${tok ? "&pageToken=" + tok : ""}`);
    all = all.concat(j.spaces || []);
    if (!(tok = j.nextPageToken)) break;
  }
  return all.sort((a, b) => String(b.lastActiveTime || "").localeCompare(String(a.lastActiveTime || "")));
}
async function readState(env, spaceName) {
  try {
    const j = await gapi(env, `${G.chat}users/me/${spaceName}/spaceReadState`);
    return j.lastReadTime || "1970-01-01T00:00:00Z";
  } catch { return "1970-01-01T00:00:00Z"; }
}
async function spaceMessages(env, spaceName, after, size = 15) {
  const f = after ? `&filter=${encodeURIComponent(`createTime > "${after}"`)}` : "";
  const j = await gapi(env, `${G.chat}${spaceName}/messages?pageSize=${size}&orderBy=${encodeURIComponent("createTime desc")}${f}`);
  return (j.messages || []).reverse();
}
// שמות המשתתפים בשיחה (users/123 -> שם)
async function spaceMembers(env, spaceName) {
  const map = {};
  try {
    const j = await gapi(env, `${G.chat}${spaceName}/members?pageSize=200`);
    for (const m of j.memberships || []) {
      const u = m.member;
      if (u?.name) map[u.name] = u.displayName || (u.email ? u.email.split("@")[0] : "");
    }
  } catch {}
  return map;
}
// סרטונים והקלטות בהודעות צאט: קבצים מצורפים (וידאו/אודיו) וקישורי יוטיוב
const YT_RE = /(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})[^\s]*/g;
const isMediaAtt = (a) => /^(video|audio)\//.test(a.contentType || "") || /\.(mp4|mov|m4a|m4v|mp3|ogg|opus|wav|webm|3gp|aac|amr|wma|wmv|flac|avi|mkv)$/i.test(a.contentName || "");
function mediaOf(m) {
  const out = [];
  for (const a of m.attachment || []) {
    if (isMediaAtt(a)) out.push({ kind: "file", name: a.contentName || "קובץ", mime: a.contentType || "", res: a.attachmentDataRef?.resourceName || "", drive: a.driveDataRef?.driveFileId || "", video: /^video\//.test(a.contentType || "") || /\.(mp4|mov|webm|3gp|avi|mkv|m4v|wmv)$/i.test(a.contentName || "") });
  }
  for (const x of String(m.text || "").matchAll(YT_RE)) out.push({ kind: "youtube", id: x[1], msgName: m.name || "", thread: m.thread?.name || "", ut: m.lastUpdateTime || m.createTime || "", text: String(m.text || "").slice(0, 300) });
  return out;
}
const msgText = (m) => {
  let t = String(m.text || m.formattedText || "").replace(YT_RE, " קישור לסרטון ביוטיוב ").trim();
  for (const a of m.attachment || []) {
    const word = isMediaAtt(a) ? (/^audio\//.test(a.contentType || "") ? "צורפה הקלטה" : "צורף סרטון") : /^image\//.test(a.contentType || "") ? "צורפה תמונה" : "צורף קובץ";
    t += (t ? ". " : "") + word;
  }
  return t || "הודעה בלי טקסט";
};

// סריקת שיחות עם הודעות שלא נקראו. kind: "dm" | "group" | "all"
async function chatUnread(env, kind) {
  const me = await myUserId(env);
  const since = Date.now() - 30 * 86400e3;
  const mute = await kvJson(env, "mute", []);
  const spaces = (await chatSpaces(env))
    .filter((s) => kind === "all" || (kind === "dm" ? isDM(s) : isGroup(s)))
    .filter((s) => !mute.includes(s.name))
    .filter((s) => !s.lastActiveTime || Date.parse(s.lastActiveTime) > since)
    .slice(0, MAX_CHAT_SPACES);
  const res = await Promise.all(spaces.map(async (s) => {
    const lr = await readState(env, s.name);
    if (s.lastActiveTime && s.lastActiveTime <= lr) return null;
    let msgs = await spaceMessages(env, s.name, lr, 15).catch(() => []);
    msgs = msgs.filter((m) => m.sender?.name !== "users/" + me);
    if (!msgs.length) return null;
    const mention = msgs.some((m) => (m.annotations || []).some((a) => a.type === "USER_MENTION" && a.userMention?.user?.name === "users/" + me));
    return { space: s.name, dm: isDM(s), title: s.displayName || "", mention, msgs: msgs.map((m) => ({ u: m.sender?.name || "", t: msgText(m), thread: m.thread?.name || "", media: mediaOf(m), name: m.name || "", atts: attsOf(m) })) };
  }));
  // שיחות שמזכירים בהן אותי קודם
  const out = res.filter(Boolean).sort((a, b) => (b.mention ? 1 : 0) - (a.mention ? 1 : 0));
  await Promise.all(out.map(async (c) => {
    const names = await spaceMembers(env, c.space);
    if (c.dm) c.title = Object.entries(names).find(([u]) => u !== "users/" + me)?.[1] || "איש קשר";
    else if (!c.title) c.title = "קבוצה בלי שם";
    for (const m of c.msgs) m.n = names[m.u] || (await userName(env, m.u));
  }));
  return out;
}
async function chatMarkRead(env, space) {
  await gapi(env, `${G.chat}users/me/${space}/spaceReadState?updateMask=lastReadTime`, { method: "PATCH", body: { lastReadTime: new Date().toISOString() } });
}
async function chatSend(env, space, body) {
  return gapi(env, `${G.chat}${space}/messages`, { body: { text: body } });
}
async function chatDMSpace(env, email, create = true) {
  try {
    const j = await gapi(env, `${G.chat}spaces:findDirectMessage?name=${encodeURIComponent("users/" + email)}`);
    if (j.name) return j.name;
  } catch (e) { if (e.status !== 404) throw e; }
  if (!create) return ""; // חיפוש בלבד: לא פותחים שיחה חדשה בצאט רק כדי לקרוא
  const j = await gapi(env, `${G.chat}spaces:setup`, {
    body: { space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: "users/" + email, type: "HUMAN" } }] },
  });
  return j.name;
}

export { ym, geminiBusy, isBusy, markBusy, geminiCall, nameHints, STT_CONTEXT, transcribe, llm, SPOKEN, isForeign, toHebrew, DWD_SCOPES, saToken, accessToken, NotConnected, gapi, header, parseAddr, htmlToText, bodyOf, MAIL_CATS, CAT_NAME, gmailUnread, gmailGet, isInlineImage, countAttachments, gmailMarkRead, encHeader, wrap76, gmailSend, myUserId, userName, contactBook, normName, findPeople, isDM, isGroup, chatSpaces, readState, spaceMessages, spaceMembers, YT_RE, isMediaAtt, mediaOf, msgText, chatUnread, chatMarkRead, chatSend, chatDMSpace };

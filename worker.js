// קו טלפוני לניהול מייל וצ'אט (Google Workspace) דרך ימות המשיח
// Cloudflare Worker — שלוחת API

const YM = "https://www.call2all.co.il/ym/api/";
const G = {
  gmail: "https://gmail.googleapis.com/gmail/v1/users/me/",
  chat: "https://chat.googleapis.com/v1/",
  people: "https://people.googleapis.com/v1/",
};
const SCOPES = [
  "openid", "email", "profile",
  // מייל
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
  // צ'אט
  "https://www.googleapis.com/auth/chat.spaces",
  "https://www.googleapis.com/auth/chat.spaces.create",
  "https://www.googleapis.com/auth/chat.memberships",
  "https://www.googleapis.com/auth/chat.messages",
  "https://www.googleapis.com/auth/chat.messages.reactions",
  "https://www.googleapis.com/auth/chat.users.readstate",
  // אנשי קשר
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/directory.readonly",
  // דרייב, מסמכים, גיליונות, מצגות, טפסים
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.activity.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  // יומן, משימות, מיט
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/meetings.space.created",
  "https://www.googleapis.com/auth/meetings.space.readonly",
  // יוטיוב (חיפוש סרטונים וכותרות). חשבון שחובר לפני הוספת ההרשאה צריך חיבור מחדש בדף /connect, או מפתח YT_KEY
  "https://www.googleapis.com/auth/youtube.readonly",
];
const MAX_CHAT_SPACES = 8;

// ---------------------------------------------------------------- כלי עזר

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const text = (body) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
const normPhone = (p) => {
  let d = String(p || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return d;
};
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const utf8b64 = (str) => b64(new TextEncoder().encode(str));
const b64url = (str) => utf8b64(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function unb64url(s) {
  const bin = atob(String(s || "").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
const decodeBody = (data, charset) => {
  try { return new TextDecoder(charset || "utf-8").decode(unb64url(data)); } catch { return new TextDecoder().decode(unb64url(data)); }
};
async function sha(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s)));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randKey = (n = 24) => {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function kvJson(env, key, def = null) {
  try { const v = await env.KV.get(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
async function logEvent(env, line) {
  try {
    const l = await kvJson(env, "log", []);
    l.unshift(new Date().toISOString().slice(0, 16).replace("T", " ") + " | " + line);
    await env.KV.put("log", JSON.stringify(l.slice(0, 60)));
  } catch {}
}

// ---------------------------------------------------------------- דיבור (טקסט לימות)

// ניקוי טקסט כדי שימות יקריא אותו בלי לשבור את התחביר
const HEB_MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const HEB_ABBR = { 'ש"ח': "שקלים", 'ד"ר': "דוקטור", 'עו"ד': "עורך דין", 'רו"ח': "רואה חשבון", 'ת"ז': "תעודת זהות", 'ת"א': "תל אביב", 'ת.ד.': "תא דואר", 'ת.ז.': "תעודת זהות" };
// הנקודה מפרידה משפטים בימות, והמירכאות והמקפים נמחקים, לכן תאריכים, מחירים, קיצורים וכתובות מתורגמים למילים לפני ההקראה
function cleanForSpeech(s) {
  return String(s || "")
    .replace(/\b(re|fwd?|fw)\s*:/gi, " ") // Re: Fwd: בנושאים נקראים כמילים באנגלית
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => (HEB_MONTHS[+mo - 1] ? `${+d} ב${HEB_MONTHS[+mo - 1]} ${y}` : m)) // תאריך ISO, אחרת הוא מאוית ספרה ספרה כמו טלפון
    .replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/g, (m, d, mo, y) => (HEB_MONTHS[+mo - 1] ? `${+d} ב${HEB_MONTHS[+mo - 1]} ${y}` : `${d} ${mo} ${y}`)) // 16.10.2026
    .replace(/ש"ח|ד"ר|עו"ד|רו"ח|ת"ז|ת"א|ת\.ד\.|ת\.ז\./g, (m) => HEB_ABBR[m] || m)
    .replace(/([\u05D0-\u05EA])["\u05F4]([\u05D0-\u05EA])/g, "$1$2") // מנכ"ל -> מנכל (אחרת המירכאות נמחקות ונשאר "מנכ ל")
    .replace(/([\u05D0-\u05EA])\.([\u05D0-\u05EA])\.?/g, "$1$2") // ר.ת. -> רת
    .replace(/(\d)\s*%/g, "$1 אחוז")
    .replace(/₪\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*₪/g, (m, a, b) => `${a || b} שקלים`)
    .replace(/\$\s*(\d[\d,]*(?:\.\d+)?)/g, "$1 דולר").replace(/€\s*(\d[\d,]*(?:\.\d+)?)/g, "$1 יורו").replace(/[₪€£]/g, " ")
    .replace(/(\d)\.(\d)/g, "$1 נקודה $2") // 3.5 -> "3 נקודה 5"
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mm) => (mm === "00" ? String(+h) : mm === "30" ? `${+h} וחצי` : mm === "15" ? `${+h} ורבע` : `${+h} ו${+mm} דקות`))
    .replace(/\u05BE/g, " ") // מקף עברי הוא מפריד מילים (הטווח של הניקוד למטה היה מוחק אותו ומדביק מילים)
    .replace(/\+?\d[\d\- ]{7,}\d/g, (m) => { const d = m.replace(/\D/g, ""); return d.length >= 9 ? " " + d.split("").join(" ") + " " : m; })
    .replace(/([\u05D0-\u05EA])['’]/g, "$1\u05F3")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " קישור ")
    .replace(/\S+@\S+\.\S+/g, (m) => " " + m.split("@")[0].replace(/[._\-]/g, " ") + " ")
    .replace(/\b([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)\b/gi, (m) => m.replace(/\./g, " ")) // example.co.il -> example co il (לא שלושה משפטים)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{200E}\u{200F}\u{202A}-\u{202E}]/gu, " ")
    .replace(/[֑-ׇ]/g, ""); // ניקוד וטעמים
}
function say(t) {
  const parts = cleanForSpeech(t)
    .split(/[.!?;:\n\r]+/)
    .map((p) => p.replace(/[\-"'&|=,*#<>\[\]{}()_~`^\\\/+%$@]/g, " ").replace(/\d{7,}/g, (m) => m.split("").join(" ")).replace(/\s+/g, " ").trim())
    .filter((p) => p && /[\p{L}\p{N}]/u.test(p));
  return parts.length ? parts.map((p) => "t-" + p).join(".") : "t-אין";
}
const trimText = (s, n) => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (at > n * 0.6 ? cut.slice(0, at + 1) : cut) + " ...";
};

// ---------------------------------------------------------------- תשובות לימות

// טקסט להקראה נשמר כסימון זמני, ובסוף הבקשה הוא הופך לקול טבעי (קובץ) או ל-TTS של ימות (ראה renderSpeech)
const SP0 = "\u0001", SP1 = "\u0002";
// kind: c = תוכן (מיילים, הודעות, תשובות), m = תפריט או הנחיה. במצב "קול טבעי לתוכן" רק התוכן עובר ל-Gemini TTS
const sp = (t, kind = "c") => SP0 + kind + b64url(String(t ?? "")) + SP1;
const R = {
  msg: (t) => `id_list_message=${sp(t)}&`,
  note: (t) => `id_list_message=${sp(t, "m")}&`, // הודעת מצב קצרה: תמיד בקול המהיר
  menu: (st, prompt, allowed = "", max = 1) => {
    const v = nextVal(st);
    // השדה השביעי (block_asterisk) חייב להיות no: אחרת ימות חוסמת את הכוכבית ומשמיעה "לא ניתן להקיש מקש כוכבית",
    // והשמיעה החוזרת (כוכבית) לא מגיעה לקוד בכלל
    return `read=${sp(prompt, "m")}=${v},no,${max},1,10,No,no,no,,${allowed ? allowed + (globalThis.__noStar ? "" : ".*") : ""},,Ok,none,`;
  },
  digits: (st, prompt, min, max) => {
    const v = nextVal(st);
    return `read=${sp(prompt, "m")}=${v},no,${max},${min},15,No,yes,no,,,,Ok,none,`;
  },
  record: (st, prompt) => {
    const v = nextVal(st);
    // בלי אורך מינימלי: סולמית מיד (בלי לומר כלום) היא הדרך לצאת מהעוזר ומקלאוד, ועם מינימום ימות הייתה דורשת הקלטה
    return `read=${sp(prompt, "m")}=${v},no,record,,,no,,,,180`;
  },
  hangup: () => "go_to_folder=hangup",
};
function nextVal(st) {
  st.n = (st.n || 0) + 1;
  st.expect = "V" + st.n;
  return st.expect;
}

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
  const cut = t.search(/\n\s*(On .{5,120}wrote:|ב.{3,120}נכתב:|ב.{3,120}כתב\/ה:|בתאריך .{5,160}מאת .{1,160}:|מאת: .+\n.*נשלח:|-{3,}\s*Original Message|-{3,}\s*Forwarded message|From: .+\n.*(Sent|Date):)/i);
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
async function gmailSend(env, { to, subject, body, threadId, inReplyTo, refs, att, cc }) {
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
const isMediaAtt = (a) => /^(video|audio)\//.test(a.contentType || "") || /\.(mp4|mov|m4a|mp3|ogg|opus|wav|webm|3gp|aac|avi|mkv)$/i.test(a.contentName || "");
function mediaOf(m) {
  const out = [];
  for (const a of m.attachment || []) {
    if (isMediaAtt(a)) out.push({ kind: "file", name: a.contentName || "קובץ", mime: a.contentType || "", res: a.attachmentDataRef?.resourceName || "", drive: a.driveDataRef?.driveFileId || "", video: /^video\//.test(a.contentType || "") || /\.(mp4|mov|webm|3gp|avi|mkv)$/i.test(a.contentName || "") });
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

// ---------------------------------------------------------------- מצב השיחה

// מצב כל שיחה נשמר ב-Durable Object (עקבי מיידית בין בקשות). ב-KV רק לבדיקות מקומיות.
// ---- הגשר לקלאוד: תור הודעות מהקו ותשובות מהריצות המתוזמנות (מופע DO אחד בשם claude-bridge)
// כל פעולה רצה בתוך ה-DO ולכן היא אטומית: הקו והריצה לא דורסים זה את זה.
async function bridgeOp(store, op, b = {}) {
  const msgs = (await store.get("msgs")) || [];
  const answers = (await store.get("answers")) || [];
  const live = (await store.get("live")) || { on: false, at: 0 };
  const now = Date.now();
  const beat = async () => { live.at = now; await store.put("live", live); };
  const trim = (a, n) => a.slice(-n);
  switch (op) {
    case "add": {
      const id = "m" + now.toString(36) + Math.random().toString(36).slice(2, 5);
      msgs.push({ id, text: String(b.text || "").slice(0, 4000), kind: b.kind || "msg", at: now, status: "new" });
      await store.put("msgs", trim(msgs, 200));
      return { id };
    }
    case "take": {
      const fresh = msgs.filter((m) => m.status === "new");
      fresh.forEach((m) => { m.status = "taken"; });
      if (fresh.length) await store.put("msgs", msgs);
      await store.put("lastRun", now);
      await beat();
      return { messages: fresh.map(({ id, text, kind, at }) => ({ id, text, kind, at: new Date(at).toISOString() })) };
    }
    case "peek":
      return { new_messages: msgs.filter((m) => m.status === "new").length };
    case "answer": {
      const id = "a" + now.toString(36) + Math.random().toString(36).slice(2, 5);
      answers.push({ id, re: b.re || "", text: String(b.text || "").slice(0, 6000), confirm: b.confirm || "", at: now, heard: false });
      await store.put("answers", trim(answers, 200));
      await beat();
      return { id };
    }
    case "live":
      live.on = !!b.on; live.at = now;
      await store.put("live", live);
      await store.put("lastRun", now);
      return { ok: true };
    case "state": {
      const isLive = live.on && now - live.at < 120e3;
      return { live: isLive, unheard: answers.filter((a) => !a.heard), pending: msgs.filter((m) => m.status === "new").length, lastRun: (await store.get("lastRun")) || 0, msgs: msgs.slice(-20).map(({ id, text, kind, at, status }) => ({ id, text: String(text).slice(0, 200), kind, at, status })) };
    }
    case "answerFor":
      return { answer: answers.find((a) => a.re === b.re && !a.heard) || null, live: live.on && now - live.at < 120e3 };
    case "heard": {
      const ids = new Set(b.ids || []);
      answers.forEach((a) => { if (ids.has(a.id)) a.heard = true; });
      await store.put("answers", answers);
      return { ok: true };
    }
  }
  return { error: "unknown op" };
}
async function bridge(env, op, body) {
  if (env.CALLS) {
    const r = await env.CALLS.get(env.CALLS.idFromName("claude-bridge")).fetch("https://do/bridge/" + op, { method: "POST", body: JSON.stringify(body || {}) });
    return r.json();
  }
  const store = { get: async (k) => kvJson(env, "bridge:" + k), put: async (k, v) => env.KV.put("bridge:" + k, JSON.stringify(v)) };
  return bridgeOp(store, op, body);
}

export class CallState {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(req) {
    const st = this.state.storage;
    const path = new URL(req.url).pathname;
    if (path.startsWith("/bridge/")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      return new Response(JSON.stringify(await bridgeOp(st, path.slice(8), body)));
    }
    if (path === "/claim") {
      // נעילה אטומית של קלט: אם ימות שולחת את אותה בקשה פעמיים (למשל כשהתשובה מתעכבת), רק הראשונה מטופלת
      const b = await req.json().catch(() => ({}));
      const cur = await st.get("busy");
      if (cur && cur.expect === b.expect && Date.now() - cur.at < BUSY_MS) return new Response(JSON.stringify({ ok: false }));
      await st.put("busy", { expect: b.expect, at: Date.now() });
      return new Response(JSON.stringify({ ok: true }));
    }
    if (path === "/busy") return new Response(JSON.stringify((await st.get("busy")) ?? null));
    if (path === "/startjob") {
      const b = await req.json();
      await st.put("pendingJob", b);
      await st.put("job", { id: b.id, status: "run" });
      await st.setAlarm(Date.now() + 50);
      return new Response("ok");
    }
    const key = path === "/job" ? "job" : "st";
    if (req.method === "PUT") {
      await st.put(key, await req.json());
      if (key === "st") await st.delete("busy");
      if (!(await st.get("pendingJob"))) await st.setAlarm(Date.now() + 3 * 3600e3);
      return new Response("ok");
    }
    if (req.method === "DELETE") { await st.deleteAll(); return new Response("ok"); }
    return new Response(JSON.stringify((await st.get(key)) ?? null));
  }
  async alarm() {
    const st = this.state.storage;
    const pj = await st.get("pendingJob");
    if (pj) {
      await st.delete("pendingJob");
      let res;
      try { res = await runJob(this.env, pj.job); }
      catch (e) { await logEvent(this.env, "שגיאה במשימת רקע: " + e.message); res = { kind: "say", text: pj.job?.type === "ai" ? "הייתה תקלה. נסה שוב." : "לא הצלחתי להכין את זה לשמיעה." }; }
      await st.put("job", { id: pj.id, status: "done", ...res });
      await st.setAlarm(Date.now() + 3 * 3600e3);
      return;
    }
    await st.deleteAll();
  }
}
const stub = (env, callId) => env.CALLS.get(env.CALLS.idFromName(callId));
async function getJob(env, callId) {
  if (env.CALLS) return (await stub(env, callId).fetch("https://do/job")).json();
  return kvJson(env, "job:" + callId);
}
async function setJob(env, callId, job) {
  if (env.CALLS) { await stub(env, callId).fetch("https://do/job", { method: "PUT", body: JSON.stringify(job) }); return; }
  await env.KV.put("job:" + callId, JSON.stringify(job), { expirationTtl: 3600 });
}
async function loadState(env, callId) {
  if (env.CALLS) return (await stub(env, callId).fetch("https://do/")).json();
  return kvJson(env, "call:" + callId);
}
async function saveState(env, callId, st) {
  if (env.CALLS) { await stub(env, callId).fetch("https://do/", { method: "PUT", body: JSON.stringify(st) }); return; }
  await env.KV.put("call:" + callId, JSON.stringify(st), { expirationTtl: 3 * 3600 });
  await env.KV.delete("busy:" + callId).catch(() => {});
}
// נעילת קלט: true אם הבקשה הזו היא הראשונה שמטפלת בערך הזה (בלי DO, לבדיקות: KV)
const BUSY_MS = 40e3;
async function claimInput(env, callId, expect) {
  if (env.CALLS) return (await (await stub(env, callId).fetch("https://do/claim", { method: "POST", body: JSON.stringify({ expect }) })).json()).ok;
  const k = "busy:" + callId, cur = await kvJson(env, k);
  if (cur && cur.expect === expect && Date.now() - cur.at < BUSY_MS) return false;
  await env.KV.put(k, JSON.stringify({ expect, at: Date.now() }), { expirationTtl: 120 });
  return true;
}
async function busyOf(env, callId) {
  if (env.CALLS) return (await stub(env, callId).fetch("https://do/busy")).json();
  return kvJson(env, "busy:" + callId);
}
async function dropState(env, callId) {
  if (env.CALLS) { await stub(env, callId).fetch("https://do/", { method: "DELETE" }).catch(() => {}); return; }
  await env.KV.delete("call:" + callId).catch(() => {});
}

// ---------------------------------------------------------------- התפריטים

const MAIN_PROMPT = "לתיבת המייל הקש 1. להודעות פרטיות בצאט הקש 2. לקבוצות הקש 3. לשליחת הודעה חדשה הקש 4. לסיכום של כל מה שהגיע הקש 5. לעוזר החכם הקש 6. לשיחה עם קלאוד הקש 7. לקבצים ולהקלטות הקש 8. להגדרות ולמערכות הקש 9. כדי לומר בדיבור לאן ללכת הקש 0. בכל שלב, לשמיעה חוזרת הקש כוכבית.";
const MAIN_SHORT = "מייל 1. צאט פרטי 2. קבוצות 3. הודעה חדשה 4. סיכום 5. העוזר החכם 6. קלאוד 7. קבצים 8. הגדרות 9. בדיבור 0.";
const MAIN_KEYS = "0.1.2.3.4.5.6.7.8.9";
const MAIL_MENU = "להקראה מלאה הקש 1. לתשובה בהקלטה הקש 2. למייל הבא הקש 3. לסימון כנקרא ומעבר לבא הקש 4. לתקציר הקש 5. לעוד אפשרויות הקש 6. לתפריט הראשי הקש 0.";
const MAIL_KEYS = "0.1.2.3.4.5.6";
const CONV_MENU = "לשמיעה חוזרת הקש 1. לתשובה בהקלטה הקש 2. לשיחה הבאה הקש 3. לסימון כנקרא ומעבר לבאה הקש 4. לעוד אפשרויות הקש 6. לתפריט הראשי הקש 0.";
const REC_PROMPT = "אמור את ההודעה אחרי הצליל. בסיום הקש סולמית.";

const H = {};

H.start = async (st, input, ctx) => {
  const allowed = String(ctx.env.ALLOWED_PHONES || "").split(",").map(normPhone).filter(Boolean);
  if (!allowed.includes(normPhone(ctx.q.ApiPhone))) {
    await logEvent(ctx.env, "ניסיון כניסה ממספר לא מורשה: " + (ctx.q.ApiPhone || "חסוי"));
    securityAlert(ctx.env, ctx, "מישהו ניסה להיכנס לקו ממספר לא מורשה: " + (ctx.q.ApiPhone || "חסוי"));
    return R.msg("המספר שממנו התקשרת אינו מורשה להיכנס לקו הזה") + R.hangup();
  }
  const fails = +(await ctx.env.KV.get("pinfails")) || 0;
  if (fails >= 6) return R.msg("הכניסה חסומה זמנית בגלל ניסיונות כניסה שגויים. נסה שוב בעוד שעה") + R.hangup();
  st.step = "pin";
  return R.digits(st, "שלום. הקש את הקוד הסודי ובסיום סולמית", 4, 8);
};

async function currentPinHash(env) {
  return (await env.KV.get("pin_hash")) || (await sha(env.PIN || ""));
}

H.pin = async (st, input, ctx) => {
  const env = ctx.env;
  if (input && input !== "none" && (await sha(input)) === (await currentPinHash(env))) {
    await env.KV.delete("pinfails").catch(() => {});
    st.authed = true;
    return go(st, "welcome", undefined, ctx);
  }
  st.tries = (st.tries || 0) + 1;
  if (input && input !== "none") {
    const f = (+(await env.KV.get("pinfails")) || 0) + 1;
    await env.KV.put("pinfails", String(f), { expirationTtl: 3600 });
    if (f >= 6) { await logEvent(env, "הקו ננעל לשעה אחרי 6 קודים שגויים"); securityAlert(env, ctx, "הקו ננעל לשעה אחרי 6 קודים שגויים ברצף."); }
  }
  if (st.tries >= 3) { securityAlert(env, ctx, `הוקש קוד סודי שגוי 3 פעמים בשיחה אחת, מהמספר ${ctx.q.ApiPhone || "חסוי"}.`); return R.msg("הקוד שגוי. להתראות") + R.hangup(); }
  return R.digits(st, input === "none" ? "לא הוקש קוד. הקש את הקוד הסודי ובסיום סולמית" : "הקוד שגוי. נסה שוב ובסיום סולמית", 4, 8);
};

H.welcome = async (st, input, ctx) => {
  const env = ctx.env;
  let intro = "";
  try {
    const [prim, upd] = await Promise.all([gmailUnread(env, 50, "primary"), gmailUnread(env, 50, "updates")]);
    const mails = prim.length, upds = upd.length;
    const n50 = (n) => (n >= 50 ? "יותר מ 50" : n);
    let convs = [];
    try { convs = await chatUnread(env, "all"); } catch (e) { await logEvent(env, "שגיאת צאט בכניסה: " + e.message); }
    const dms = convs.filter((c) => c.dm).length, grs = convs.length - dms;
    const mentions = convs.filter((c) => c.mention).length;
    const parts = [];
    const vipN = await vipUnreadCount(env).catch(() => 0);
    parts.push(mails ? (mails === 1 ? "בתיבה הראשית יש מייל אחד חדש" : `בתיבה הראשית יש ${n50(mails)} מיילים חדשים`) + (vipN ? `, מתוכם ${vipN === 1 ? "אחד מאדם חשוב" : vipN + " מאנשים חשובים"}` : "") : "אין מיילים חדשים בתיבה הראשית");
    parts.push(upds ? (upds === 1 ? "בעדכונים יש מייל אחד חדש" : `בעדכונים יש ${n50(upds)} מיילים חדשים`) : "אין מיילים חדשים בעדכונים");
    parts.push(dms ? (dms === 1 ? "שיחה פרטית אחת עם הודעות חדשות" : `${dms} שיחות פרטיות עם הודעות חדשות`) : "אין הודעות פרטיות חדשות");
    parts.push(grs ? (grs === 1 ? "וקבוצה אחת עם הודעות חדשות" : `ו ${grs} קבוצות עם הודעות חדשות`) : "ואין הודעות חדשות בקבוצות");
    if (mentions) parts.push(mentions === 1 ? "בשיחה אחת מזכירים אותך" : `ב ${mentions} שיחות מזכירים אותך`);
    try {
      const b = await bridge(env, "state");
      const n = b.unheard.length;
      if (n) parts.push(n === 1 ? "יש לך תשובה חדשה מקלאוד" : `יש לך ${n} תשובות חדשות מקלאוד`);
      if (b.live) parts.push("קלאוד מחובר עכשיו לשיחה");
    } catch {}
    intro = parts.join(". ") + ".";
  } catch (e) {
    if (e instanceof NotConnected) return R.msg("חשבון הגוגל עדיין לא מחובר לקו. צריך להיכנס לדף החיבור ולחבר אותו. להתראות") + R.hangup();
    throw e;
  }
  const r = await kvJson(env, "resume");
  if (r && Date.now() - r.t < 3 * 3600e3 && (r.kind !== "mail" || r.ids?.length)) { st.resume = r; return R.note(intro) + (await go(st, "resumeAsk", undefined, ctx)); }
  return R.note(intro) + (await go(st, "main", undefined, ctx));
};

H.main = async (st, input, ctx, pre = "") => {
  if (input === undefined) {
    st.step = "main";
    st.mainN = (st.mainN || 0) + 1;
    delete st.mail; delete st.conv; delete st.share; delete st.cands; // הקשר של זרימה שנקטעה לא נגרר לזרימה הבאה
    return (pre ? R.msg(pre) : "") + R.menu(st, st.mainN > 1 ? MAIN_SHORT : MAIN_PROMPT, MAIN_KEYS);
  }
  if (input === "none") {
    st.idle = (st.idle || 0) + 1;
    if (st.idle >= 3) return R.msg("להתראות") + R.hangup();
    return R.menu(st, MAIN_PROMPT, MAIN_KEYS);
  }
  st.idle = 0;
  const to = { 1: "mailStart", 2: "dmStart", 3: "grpStart", 4: "newStart", 5: "summary", 6: "aiStart", 7: "claudeStart", 8: "filesMenu", 9: "settingsMenu", 0: "navRec" }[input];
  if (!to) return R.menu(st, "בחירה לא קיימת. " + MAIN_SHORT, MAIN_KEYS);
  return go(st, to, undefined, ctx);
};

// ---- מייל

const TODO_LABEL = "לטיפול";
const SNOOZE_LABEL = "נדחה";
async function vipList(env) { return kvJson(env, "vip", []); }
const vipQuery = (vip) => (vip.length ? ` from:(${vip.map((v) => v.e).join(" OR ")})` : "");
async function vipUnreadCount(env) {
  const vip = await vipList(env);
  if (!vip.length) return 0;
  return (await gmailUnread(env, 50, "primary")).length ? (await gmailIds(env, "in:inbox is:unread" + vipQuery(vip), 50)).length : 0;
}
// נתוני מייל קצרים (שולח, תוויות) להרבה מיילים בבת אחת
async function mailMeta(env, ids) {
  return Promise.all(ids.map((id) => gapi(env, `${G.gmail}messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=To`)
    .then((x) => ({ id, threadId: x.threadId || "", from: parseAddr(header(x, "From")), subject: header(x, "Subject"), to: header(x, "To"), date: header(x, "Date"), labels: x.labelIds || [], snippet: x.snippet || "" })).catch(() => null)));
}
// מיון: אנשים חשובים קודם, אחר כך מה שגוגל סימן כחשוב, ואחר כך השאר
async function sortImportant(env, ids) {
  if (ids.length < 2) return ids;
  const vip = new Set((await vipList(env)).map((v) => v.e.toLowerCase()));
  const meta = (await mailMeta(env, ids.slice(0, 30))).filter(Boolean);
  const rank = (m) => (vip.has(m.from.email.toLowerCase()) ? 0 : m.labels.includes("IMPORTANT") ? 1 : 2);
  const sorted = meta.slice().sort((a, b) => rank(a) - rank(b)).map((m) => m.id);
  return sorted.concat(ids.filter((id) => !sorted.includes(id)));
}
const MAIL_LIST_NAMES = { primary: "התיבה הראשית", updates: "העדכונים", vip: "המיילים מאנשים חשובים", todo: "רשימת לטיפול", search: "תוצאות החיפוש", unanswered: "המיילים שלא נענו" };

H.mailStart = async (st, input, ctx, pre = "") => {
  const env = ctx.env;
  if (input === undefined) {
    const [prim, upd, vip, todo] = await Promise.all([
      gmailUnread(env, 25, "primary"), gmailUnread(env, 25, "updates"),
      vipList(env).then((v) => (v.length ? gmailIds(env, "in:inbox is:unread" + vipQuery(v), 25) : [])).catch(() => []),
      gmailLabelId(env, TODO_LABEL).then((l) => gmailIds(env, `label:${TODO_LABEL}`, 25)).catch(() => []),
    ]);
    st.cats = { primary: prim, updates: upd, vip, todo };
    st.step = "mailStart";
    const c = (n, one, many) => (n ? (n === 1 ? one : `${n} ${many}`) : null);
    const counts = [c(prim.length, "בתיבה הראשית מייל אחד חדש", "בתיבה הראשית"), c(upd.length, "בעדכונים מייל אחד", "בעדכונים"), c(vip.length, "מאנשים חשובים מייל אחד", "מאנשים חשובים"), c(todo.length, "ברשימת לטיפול מייל אחד", "ברשימת לטיפול")].filter(Boolean);
    const head = counts.length ? counts.map((x) => (/^\d/.test(x) ? x.replace(/^(\d+) (.*)$/, "$2 $1") : x)).join(", ") + "." : "אין מיילים חדשים.";
    return (pre ? R.msg(pre) : "") + R.msg(head) + R.menu(st, "לתיבה הראשית הקש 1. לעדכונים הקש 2. למיילים מאנשים חשובים הקש 3. לרשימת לטיפול הקש 4. לחיפוש מייל בדיבור הקש 5. למיילים ששלחת ולא נענו הקש 6. לתפריט הראשי הקש 0.", "0.1.2.3.4.5.6");
  }
  const cat = { 1: "primary", 2: "updates", 3: "vip", 4: "todo" }[input];
  if (cat) {
    if (!st.cats?.[cat]?.length) return go(st, "mailStart", undefined, ctx, `אין מיילים ב${MAIL_LIST_NAMES[cat]}.`);
    const ids = cat === "primary" ? await sortImportant(env, st.cats[cat]) : st.cats[cat];
    return startCat(st, ctx, cat, ids);
  }
  if (input === "5") return go(st, "mailSearchRec", undefined, ctx);
  if (input === "6") return go(st, "unanswered", undefined, ctx);
  return go(st, "main", undefined, ctx);
};
function startCat(st, ctx, cat, ids, pre = "") {
  st.mail = { ids, i: 0, cat, name: MAIL_LIST_NAMES[cat] };
  delete st.cats;
  return go(st, "mailItem", undefined, ctx, (pre ? pre + " " : "") + MAIL_LIST_NAMES[cat] + ".");
}

// חיפוש מייל בדיבור: "המייל מדוד על החשבונית מהשבוע שעבר"
H.mailSearchRec = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "mailSearchRec"; return (pre ? R.msg(pre) : "") + R.record(st, "אמור מה לחפש, למשל: המייל מדוד על החשבונית מהשבוע שעבר. בסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "nav");
  if (!spoken) return go(st, "mailStart", undefined, ctx, "לא שמעתי.");
  return mailSearchRun(st, ctx, spoken);
};
async function buildMailQuery(env, spoken) {
  let j = {};
  try {
    const out = await llm(env, `המשתמש אמר בטלפון מה לחפש בתיבת המייל שלו. חלץ JSON בלבד עם השדות: person (שם האדם או החברה ששלחו, או ריק), subject (מילות מפתח לנושא או לתוכן, עד 3 מילים, או ריק), days (כמה ימים אחורה לחפש, מספר, ברירת מחדל 60), sent (true אם הוא מחפש מייל ששלח בעצמו). התאריך היום ${nowIL()}. החזר רק JSON.`, spoken, 150);
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {}
  const parts = [];
  if (j.person) {
    const found = (await findPeople(env, j.person).catch(() => [])).slice(0, 4);
    const names = [j.person, ...found.map((f) => f.e), ...found.map((f) => f.n)].filter(Boolean).map((x) => `"${String(x).replace(/"/g, "")}"`);
    parts.push(`${j.sent ? "to" : "from"}:(${[...new Set(names)].join(" OR ")})`);
  }
  if (j.subject) parts.push(`(${String(j.subject).split(/\s+/).filter(Boolean).slice(0, 3).map((w) => `"${w}"`).join(" ")})`);
  if (!j.person && !j.subject) {
    // המודל לא חילץ כלום: מחפשים לפי המילים שנאמרו, במקום להחזיר 10 מיילים אקראיים
    const stop = new Set(["המייל", "מייל", "מיילים", "של", "על", "את", "עם", "מה", "מי", "לי", "לא", "יש", "זה", "תמצא", "תחפש", "חפש", "מצא", "בבקשה", "אני", "רוצה", "לשמוע", "תשמיע", "שלח", "ששלח", "ששלחתי", "קיבלתי", "שקיבלתי"]);
    const words = String(spoken).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter((w) => w.length >= 3 && !stop.has(w)).slice(0, 5);
    if (words.length) parts.push(`(${words.map((w) => `"${w}"`).join(" OR ")})`);
  }
  parts.push(`newer_than:${Math.min(365, Math.max(1, +j.days || 60))}d`);
  if (j.sent) parts.push("in:sent");
  return parts.join(" ");
}
async function mailSearchRun(st, ctx, spoken) {
  const env = ctx.env;
  const q = await buildMailQuery(env, spoken);
  const ids = await gmailIds(env, q, 10);
  if (!ids.length) return go(st, "mailStart", undefined, ctx, `לא מצאתי מיילים לפי החיפוש ${spoken}.`);
  st.mail = { ids, i: 0, cat: "search", name: "תוצאות החיפוש" };
  return go(st, "mailItem", undefined, ctx, `מצאתי ${ids.length === 1 ? "מייל אחד" : ids.length + " מיילים"}.`);
}

// מיילים ששלחתי ולא קיבלתי עליהם תשובה
H.unanswered = async (st, input, ctx) => {
  const env = ctx.env;
  const sent = await gmailIds(env, "in:sent newer_than:10d -subject:שש", 15);
  const meta = (await mailMeta(env, sent)).filter(Boolean);
  const seen = new Set(), picks = [];
  for (const m of meta) if (m.threadId && !seen.has(m.threadId)) { seen.add(m.threadId); picks.push(m); }
  // כל השרשורים במקביל (לא 30 קריאות אחת אחרי השנייה, שימות לא מחכה להן)
  const threads = await Promise.all(picks.map((m) => gapi(env, `${G.gmail}threads/${m.threadId}?format=metadata&metadataHeaders=From`).then((th) => ({ m, th })).catch(() => null)));
  const out = [];
  for (const x of threads) {
    if (!x) continue;
    const { m, th } = x;
    const last = th?.messages?.[th.messages.length - 1];
    if (!last) continue;
    const fromMe = parseAddr(header(last, "From")).email.toLowerCase() === String(env.BUSINESS_EMAIL).toLowerCase();
    const ageDays = (Date.now() - +last.internalDate) / 86400e3;
    if (fromMe && ageDays >= 1 && !/^(re|fwd?|הועבר):/i.test(m.subject || "") && !/^\s*(סיכום יומי|תשובה מקלאוד)/.test(m.subject || "")) out.push(last.id);
  }
  if (!out.length) return go(st, "mailStart", undefined, ctx, "כל המיילים ששלחת בעשרת הימים האחרונים נענו, או שלא נמצאו מיילים כאלה.");
  st.mail = { ids: out, i: 0, cat: "unanswered", name: "המיילים שלא נענו" };
  return go(st, "mailItem", undefined, ctx, `${out.length === 1 ? "מייל אחד ששלחת עדיין לא נענה" : out.length + " מיילים ששלחת עדיין לא נענו"}.`);
};

H.mailItem = async (st, input, ctx) => {
  const m = st.mail;
  if (m.i >= m.ids.length) { delete st.cur; return go(st, "main", undefined, ctx, `סיימת את ${m.name || "המיילים"}.`); }
  let e;
  try { e = await gmailGet(ctx.env, m.ids[m.i]); }
  catch (err) {
    if (err instanceof NotConnected) throw err;
    // מייל שנמחק או לא נגיש בינתיים: מדלגים עליו במקום להפיל את כל הרשימה ("אירעה תקלה")
    await logEvent(ctx.env, "דילוג על מייל שלא ניתן לקרוא: " + err.message);
    m.i++;
    return go(st, "mailItem", undefined, ctx);
  }
  st.cur = { id: e.id, threadId: e.threadId, fromName: e.fromName, fromEmail: e.fromEmail, replyTo: e.replyTo, subject: e.subject, msgId: e.msgId, refs: lastRefs(e.refs), body: e.body, to: e.to, nAtt: e.attachments, date: e.date };
  const att = e.attachments ? ` יש ${e.attachments === 1 ? "קובץ מצורף אחד" : e.attachments + " קבצים מצורפים"}.` : "";
  const sentByMe = m.cat === "unanswered";
  if (sentByMe) {
    // מייל ששלחתי: "הצד השני" הוא הנמען, ותשובה הולכת אליו (ולא אליי)
    const p = parseAddr(e.to);
    st.cur.fromName = p.name; st.cur.fromEmail = p.email; st.cur.replyTo = e.to || e.replyTo;
  }
  let head = sentByMe ? `אל: ${parseAddr(e.to).name}\nנושא: ${e.subject}\nתוכן: ${trimText(e.body, 350)}` : `מאת: ${e.fromName}\nנושא: ${e.subject}\nתוכן: ${trimText(e.body, 350)}`;
  const foreign = isForeign(e.subject + " " + e.body);
  if (foreign) head = await toHebrew(ctx.env, head, 600);
  st.cur.foreign = foreign;
  const spokenHead = head.replace(/^\s*(מאת|אל|נושא|תוכן)\s*:\s*/gm, (x, w) => (w === "תוכן" ? "" : w + " ")).replace(/\n/g, ". ");
  const when = e.date ? ` ${relDate(e.date)}.` : "";
  const intro = `מייל ${m.i + 1} מתוך ${m.ids.length}.${when}${foreign ? " המייל באנגלית, הנה תרגום." : ""} ${spokenHead}.${att}`;
  st.step = "mailMenu";
  return R.msg(intro) + R.menu(st, MAIL_MENU, MAIL_KEYS);
};
// References תקין: רק מזהים שלמים (חיתוך באמצע מזהה שובר את השרשור אצל הנמען)
const lastRefs = (r) => String(r || "").trim().split(/\s+/).filter(Boolean).slice(-12).join(" ");
function relDate(d) {
  const t = Date.parse(d);
  if (!t) return "";
  // לפי ימים בלוח (שעון ישראל): מייל מאתמול בלילה הוא "אתמול", לא "היום"
  const dayOf = (ms) => Date.parse(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)));
  const days = Math.round((dayOf(Date.now()) - dayOf(t)) / 86400e3);
  return days <= 0 ? "היום" : days === 1 ? "אתמול" : days < 7 ? `לפני ${days} ימים` : days < 14 ? "לפני שבוע" : days < 60 ? `לפני ${Math.round(days / 7)} שבועות` : "לפני יותר מחודשיים";
}
// הקראה מלאה בעמודים: כל עמוד עד 1500 תווים, ואפשר לדלג בלחיצה
H.mailRead = async (st, input, ctx) => {
  const c = st.cur;
  if (input === undefined) {
    const full = c.foreign ? await toHebrew(ctx.env, trimText(c.body, 3500), 2500) : c.body;
    c.pages = chunkText(full || "המייל ריק", 1500); c.page = 0;
  } else if (input === "1") c.page++;
  else if (input === "2") c.page = 0;
  else { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  if (c.page >= c.pages.length) { st.step = "mailMenu"; return R.msg("זה סוף המייל.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.step = "mailRead";
  const more = c.page < c.pages.length - 1;
  return R.msg(c.pages[c.page]) + R.menu(st, (more ? "להמשך הקש 1. " : "") + "לשמיעה מההתחלה הקש 2. לתפריט המייל הקש 0.", more ? "0.1.2" : "0.2");
};

H.mailMenu = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  switch (input) {
    case "1": return go(st, "mailRead", undefined, ctx);
    case "2":
      st.compose = { kind: "reply", back: "mailAfterReply", label: c.fromName };
      return go(st, "rec", undefined, ctx);
    case "3": st.mail.i++; return go(st, "mailItem", undefined, ctx);
    case "4": await gmailMarkRead(env, c.id); st.mail.i++; return go(st, "mailItem", undefined, ctx, "סומן כנקרא.");
    case "5": {
      const sum = await llm(env, "סכם את המייל הבא בשניים שלושה משפטים. ציין אם מבקשים ממני משהו ועד מתי. " + SPOKEN, `מאת: ${c.fromName}\nנושא: ${c.subject}\n\n${c.body}`, 300).catch(() => "");
      return R.msg(sum || "לא הצלחתי לסכם את המייל") + R.menu(st, MAIL_MENU, MAIL_KEYS);
    }
    case "6": return go(st, "mailMore", undefined, ctx);
    case "0": return go(st, "main", undefined, ctx);
    default: {
      st.idle = (st.idle || 0) + 1;
      if (st.idle >= 3) return R.msg("להתראות") + R.hangup();
      return R.menu(st, MAIL_MENU, MAIL_KEYS);
    }
  }
};
H.mailAfterReply = async (st, input, ctx) => {
  await gmailMarkRead(ctx.env, st.cur.id).catch(() => {});
  st.mail.i++;
  return go(st, "mailItem", undefined, ctx, "התשובה נשלחה.");
};

// עוד אפשרויות למייל
const mailMorePrompt = (st) => `לתשובה מוכנה הקש 1. לניסוח תשובה עם AI הקש 2. ${st.mail.cat === "todo" ? "להסרה מרשימת לטיפול" : "להוספה לרשימת לטיפול"} הקש 3. לדחיית המייל למועד אחר הקש 4. לשמירת המייל בדרייב הקש 5. ${st.cur.nAtt ? "לקבצים המצורפים הקש 6. " : ""}לשמירת השולח באנשי הקשר הקש 7. להוספת השולח לרשימת האנשים החשובים הקש 8. להעברת המייל לאדם אחר הקש 9. לחזרה הקש 0.`;
H.mailMore = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  const back = (pre = "") => { st.step = "mailMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, MAIL_MENU, MAIL_KEYS); };
  if (input === undefined) { st.step = "mailMore"; return R.menu(st, mailMorePrompt(st), "0.1.2.3.4.5.6.7.8.9"); }
  switch (input) {
    case "1": return go(st, "cannedPick", undefined, ctx);
    case "2":
      st.compose = { kind: "reply", back: "mailAfterReply", label: c.fromName, ai: true };
      return go(st, "rec", undefined, ctx, "אמור בקצרה מה לענות, ואני אנסח את התשובה בסגנון שלך.");
    case "3": {
      const lid = await gmailLabelId(env, TODO_LABEL, true);
      if (st.mail.cat === "todo") { await modifyEmail(env, c.id, [], [lid]); st.mail.i++; return go(st, "mailItem", undefined, ctx, "הוסר מרשימת לטיפול."); }
      await modifyEmail(env, c.id, [lid]);
      return back("נוסף לרשימת לטיפול. תמצא אותו בתפריט המייל, מקש 4.");
    }
    case "4": st.step = "snoozePick"; return R.menu(st, "לדחות למחר בבוקר הקש 1. להערב הקש 2. לעוד 3 שעות הקש 3. ליום ראשון הקש 4. לחזרה הקש 0.", "0.1.2.3.4");
    case "5": {
      const link = await saveMailToDrive(env, c);
      return back(link ? "המייל נשמר בדרייב, בתיקייה מיילים מהקו." : "השמירה נכשלה.");
    }
    case "6": if (c.nAtt) return go(st, "attList", undefined, ctx); return back();
    case "7": {
      if (!c.fromEmail || !c.fromEmail.includes("@")) return back("אין כתובת לשמור.");
      st.step = "saveSender";
      return R.menu(st, `לשמור את ${c.fromName}, בכתובת ${c.fromEmail}, באנשי הקשר? לאישור הקש 1. לחזרה הקש 0.`, "0.1");
    }
    case "8": {
      const vip = await vipList(env);
      if (!vip.some((v) => v.e.toLowerCase() === c.fromEmail.toLowerCase())) { vip.push({ n: c.fromName, e: c.fromEmail }); await env.KV.put("vip", JSON.stringify(vip.slice(-40))); }
      return back(`${c.fromName} נוסף לרשימת האנשים החשובים.`);
    }
    case "9": st.fwd = { id: c.id }; return go(st, "fwdName", undefined, ctx);
    default: return back();
  }
};
H.saveSender = async (st, input, ctx) => {
  if (input !== "1") { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  const c = st.cur;
  await ACTIONS.create_contact.run(ctx.env, { name: c.fromName, email: c.fromEmail });
  st.step = "mailMenu";
  return R.msg("איש הקשר נשמר.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
};
// דחיית מייל: יוצא מהתיבה וחוזר אליה (כלא נקרא) בזמן שנבחר
function snoozeUntil(opt) {
  const now = new Date();
  const il = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }));
  // ההפרש בין UTC לשעון ישראל נמדד בזמן היעד (לא עכשיו), כדי שדחייה שחוצה מעבר לשעון קיץ/חורף תגיע בשעה הנכונה
  const offAt = (wall) => { const m = ilOffset(new Date(wall)).match(/([+-])(\d{2}):(\d{2})/); return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60e3 : il - now; };
  const at = (dayAdd, h) => { const d = new Date(il); d.setDate(d.getDate() + dayAdd); d.setHours(h, 0, 0, 0); return d.getTime() - offAt(d.getTime()); };
  if (opt === "1") return at(1, 8);
  if (opt === "2") return il.getHours() < 19 ? at(0, 19) : at(1, 19);
  if (opt === "3") return Date.now() + 3 * 3600e3;
  if (opt === "4") return at((7 - il.getDay()) % 7 || 7, 8);
  return 0;
}
H.snoozePick = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  const until = snoozeUntil(input);
  if (!until) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  const lid = await gmailLabelId(env, SNOOZE_LABEL, true);
  await modifyEmail(env, c.id, [lid], ["INBOX"]);
  const list = await kvJson(env, "snooze", []);
  list.push({ id: c.id, until, lid });
  await env.KV.put("snooze", JSON.stringify(list.slice(-200)));
  await logEvent(env, `מייל נדחה: ${c.subject} עד ${new Date(until).toISOString()}`);
  st.mail.i++;
  return go(st, "mailItem", undefined, ctx, "המייל נדחה. הוא יחזור לתיבה כלא נקרא בזמן שבחרת.");
};
// מריץ מהמשימה המתוזמנת: מחזיר לתיבה מיילים שזמן הדחייה שלהם הגיע
async function restoreSnoozed(env) {
  const list = await kvJson(env, "snooze", []);
  if (!list.length) return;
  const now = Date.now();
  const due = list.filter((x) => x.until <= now), rest = list.filter((x) => x.until > now);
  for (const x of due) {
    try { await modifyEmail(env, x.id, ["INBOX", "UNREAD"], [x.lid]); }
    catch (e) {
      await logEvent(env, "החזרת מייל נדחה נכשלה: " + e.message);
      // תקלה זמנית: מנסים שוב בבדיקה הבאה (עד 3 ימים), כדי שהמייל לא יישאר מוסתר לתמיד
      if (e.status !== 404 && now - x.until < 3 * 86400e3) rest.push(x);
    }
  }
  if (due.length) await env.KV.put("snooze", JSON.stringify(rest));
}
// שמירת מייל כמסמך גוגל בתיקייה "מיילים מהקו"
async function driveFolder(env, name) {
  const k = "folder:" + name;
  const c = await env.KV.get(k);
  if (c) {
    // התיקייה עדיין קיימת? (תיקייה שנמחקה הייתה מפילה כל שמירה לדרייב לתמיד)
    const f = await gapi(env, `${DRIVE}files/${c}?fields=id,trashed`).catch((e) => (e.status === 404 ? null : { id: c }));
    if (f && !f.trashed) return c;
    await env.KV.delete(k).catch(() => {});
  }
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const j = await gapi(env, `${DRIVE}files?q=${encodeURIComponent(q)}&fields=files(id)`);
  let id = j.files?.[0]?.id;
  if (!id) id = (await gapi(env, `${DRIVE}files`, { body: { name, mimeType: "application/vnd.google-apps.folder" } })).id;
  await env.KV.put(k, id);
  return id;
}
async function driveUpload(env, { name, mime, bytes, folder, convertTo }) {
  const meta = { name, parents: folder ? [folder] : undefined };
  if (convertTo) meta.mimeType = convertTo;
  const b = "b" + randKey(12);
  const head = new TextEncoder().encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${b}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
    method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": `multipart/related; boundary=${b}` }, body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error("drive upload " + r.status + " " + (j.error?.message || ""));
  return j;
}
async function saveMailToDrive(env, c) {
  try {
    const folder = await driveFolder(env, "מיילים מהקו");
    const text = `מאת: ${c.fromName} <${c.fromEmail}>\nנושא: ${c.subject}\nתאריך: ${c.date || ""}\n\n${c.body}`;
    const f = await driveUpload(env, { name: c.subject || "מייל", mime: "text/plain", bytes: new TextEncoder().encode(text), folder, convertTo: "application/vnd.google-apps.document" });
    await logEvent(env, "מייל נשמר בדרייב: " + c.subject);
    return f.webViewLink || f.id;
  } catch (e) { await logEvent(env, "שמירת מייל לדרייב נכשלה: " + e.message); return ""; }
}

// תשובות מוכנות
const CANNED_DEFAULT = ["קיבלתי, תודה.", "תודה, אחזור אליך בהקדם.", "מאשר.", "לא רלוונטי עבורי, תודה."];
async function cannedList(env) {
  const l = await kvJson(env, "canned");
  if (Array.isArray(l) && l.length) return l;
  const phone = String(env.ALLOWED_PHONES || "").split(",")[0].trim();
  return phone ? [...CANNED_DEFAULT, `אפשר לדבר בטלפון? ${phone}`] : CANNED_DEFAULT;
}
H.cannedPick = async (st, input, ctx) => {
  const list = await cannedList(ctx.env);
  if (input === undefined) {
    st.step = "cannedPick";
    return R.menu(st, list.map((t, i) => `${t} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join("."));
  }
  const t = list[+input - 1];
  if (!t) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.compose = { kind: "reply", back: "mailAfterReply", label: st.cur.fromName, text: t };
  return go(st, "confirm", undefined, ctx);
};

// העברת מייל לאדם אחר
H.fwdName = async (st, input, ctx) => {
  if (input === undefined) { st.step = "fwdName"; return R.record(st, "אמור למי להעביר את המייל, ובסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) { st.step = "mailMenu"; return R.msg(spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "fwdPick";
  return R.menu(st, st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.fwdPick = async (st, input, ctx) => {
  const c = st.cands?.[+input - 1];
  if (!c) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.fwd.to = c; st.step = "fwdConfirm";
  return R.menu(st, `להעביר את המייל בנושא ${st.cur.subject} אל ${c.n}? לאישור הקש 1. לביטול הקש 0.`, "0.1");
};
H.fwdConfirm = async (st, input, ctx) => {
  st.step = "mailMenu";
  if (input !== "1") return R.msg("בוטל.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
  await ACTIONS.forward_email.run(ctx.env, { id: st.fwd.id, to: st.fwd.to.e, note: "מצורף מייל שהועבר מהטלפון." });
  await logEvent(ctx.env, `מייל הועבר ל${st.fwd.to.n}: ${st.cur.subject}`);
  delete st.fwd;
  return R.msg("המייל הועבר.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
};

// קבצים מצורפים למייל: סיכום, הקראה, שיתוף
H.attList = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur;
  if (input === undefined) {
    const m = await gapi(env, `${G.gmail}messages/${c.id}?format=full`);
    st.atts = attachmentsOf(m.payload).slice(0, 8);
    if (!st.atts.length) { st.step = "mailMenu"; return R.msg("אין קבצים מצורפים.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
    if (st.atts.length === 1) return go(st, "attList", "1", ctx);
    st.step = "attList";
    const parts = await Promise.all(st.atts.map(async (a, i) => `${await heb(env, a.name)} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...st.atts.map((_, i) => i + 1)].join("."));
  }
  const a = st.atts?.[+input - 1];
  if (!a) { st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS); }
  st.att = { ...a, index: +input };
  st.step = "attMenu";
  return R.menu(st, `הקובץ ${await heb(env, a.name)}, ${Math.max(1, Math.round(a.size / 1024))} קילובייט. לסיכום הקש 1. להקראה מלאה הקש 2. לשליחה לאדם אחר הקש 3. לשמירה בדרייב הקש 4. לחזרה הקש 0.`, "0.1.2.3.4");
};
H.attMenu = async (st, input, ctx) => {
  const env = ctx.env, c = st.cur, a = st.att;
  if (input === "1" || input === "2") {
    // הקריאה רצה ברקע עם מנגינת המתנה: קובץ גדול לוקח יותר זמן ממה שימות מחכה לתשובה
    st.media = { back: "mail" };
    return startMediaJob(ctx, st, { type: "action", name: "read_attachment", args: { id: c.id, index: a.index, mode: input === "2" ? "full" : "summary" } });
  }
  if (input === "3") { st.share = { src: { type: "gmail", mailId: c.id, attId: a.id, name: a.name, mime: a.mime, size: a.size }, back: "mail" }; return go(st, "shareWho", undefined, ctx); }
  if (input === "4") {
    try {
      const bytes = await attachmentBytes(env, c.id, a.id);
      await driveUpload(env, { name: a.name, mime: a.mime || "application/octet-stream", bytes, folder: await driveFolder(env, "קבצים מהקו") });
      st.step = "mailMenu"; return R.msg("הקובץ נשמר בדרייב, בתיקייה קבצים מהקו.") + R.menu(st, MAIL_MENU, MAIL_KEYS);
    } catch (e) { await logEvent(env, "שמירת קובץ נכשלה: " + e.message); st.step = "mailMenu"; return R.msg("השמירה נכשלה.") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  }
  st.step = "mailMenu"; return R.menu(st, MAIL_MENU, MAIL_KEYS);
};
async function attachmentBytes(env, mailId, attId) {
  const j = await gapi(env, `${G.gmail}messages/${mailId}/attachments/${attId}`);
  return unb64url(j.data);
}

// סגנון הכתיבה שלו, נלמד מהמיילים שהוא שלח (מטמון לשבוע)
async function styleProfile(env) {
  const c = await kvJson(env, "style");
  if (c && Date.now() - c.t < 7 * 86400e3) return c.s;
  let s = "";
  try {
    const ids = await gmailIds(env, "in:sent -subject:שש -subject:\"סיכום יומי\"", 20);
    const bodies = (await Promise.all(ids.map((id) => gmailGet(env, id).catch(() => null)))).filter((m) => m && m.body && m.body.length > 20 && !isForeign(m.body)).map((m) => trimText(m.body, 500));
    if (bodies.length >= 2) {
      s = await llm(env, "לפניך מיילים שכתב אדם. תאר בעד 10 שורות את סגנון הכתיבה שלו: איך הוא פותח, איך הוא חותם (ומה שמו אם מופיע), רמת הרשמיות, אורך המשפטים, ביטויים חוזרים, האם הוא משתמש בסימני קריאה. החזר רק את התיאור.", bodies.join("\n\n---\n\n"), 500);
    }
  } catch {}
  await env.KV.put("style", JSON.stringify({ t: Date.now(), s }));
  return s;
}
async function draftWithAi(env, st, instruction) {
  const cp = st.compose, c = st.cur;
  const style = await styleProfile(env);
  const ctxText = cp.kind === "reply" && c ? `המייל שעונים עליו:\nמאת: ${c.fromName}\nנושא: ${c.subject}\n${trimText(c.body, 1500)}` : `נמען: ${cp.label}`;
  return llm(env,
    `אתה כותב בשם שמואל הודעה ${cp.kind === "reply" ? "כתשובה למייל" : cp.kind === "email" ? "במייל" : "בצאט"} לפי הנחיה קצרה שאמר בטלפון. כתוב בעברית, בגוף ראשון, כמו שהוא כותב.${style ? `\nסגנון הכתיבה שלו: ${style}` : "\nסגנון: ענייני, מנומס וקצר."}\nכתוב רק את גוף ההודעה המוכנה לשליחה, בלי נושא, בלי הסברים ובלי מירכאות. אל תוסיף פרטים שלא נאמרו.`,
    `${ctxText}\n\nההנחיה שלו: ${instruction}`, 500);
}

// ---- צ'אט

H.dmStart = async (st, input, ctx) => {
  const convs = await chatUnread(ctx.env, "dm");
  if (!convs.length) return go(st, "chatEmpty", undefined, ctx, "אין הודעות פרטיות חדשות.");
  st.conv = { items: convs, i: 0, kind: "dm" };
  return go(st, "convItem", undefined, ctx);
};
H.grpStart = async (st, input, ctx) => {
  const convs = await chatUnread(ctx.env, "group");
  if (!convs.length) return go(st, "grpBrowse", undefined, ctx, "אין הודעות חדשות בקבוצות.");
  st.conv = { items: convs, i: 0, kind: "group" };
  return go(st, "convItem", undefined, ctx);
};
H.chatEmpty = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "chatEmpty"; return (pre ? R.msg(pre) : "") + R.menu(st, "לחיפוש שיחה או הודעה בדיבור הקש 1. לתפריט הראשי הקש 0.", "0.1"); }
  if (input === "1") return go(st, "chatSearchRec", undefined, ctx);
  return go(st, "main", undefined, ctx);
};

// בחירת קבוצה מתוך רשימה (גם בלי הודעות חדשות)
H.grpBrowse = async (st, input, ctx, pre = "") => {
  if (input === undefined) {
    const mute = await kvJson(ctx.env, "mute", []);
    const groups = (await chatSpaces(ctx.env)).filter(isGroup).filter((s) => !mute.includes(s.name)).slice(0, 8).map((s) => ({ space: s.name, title: s.displayName || "קבוצה בלי שם" }));
    if (!groups.length) return go(st, "main", undefined, ctx, (pre ? pre + " " : "") + "לא מצאתי קבוצות בחשבון.");
    st.groups = groups;
    st.step = "grpBrowse";
    const list = groups.map((g, i) => `לקבוצה ${g.title} הקש ${i + 1}`).join(". ");
    return (pre ? R.msg(pre) : "") + R.menu(st, list + ". לחיפוש בדיבור הקש 9. לתפריט הראשי הקש 0.", ["0", "9", ...groups.map((_, i) => String(i + 1))].join("."));
  }
  if (input === "9") return go(st, "chatSearchRec", undefined, ctx);
  if (input === "0" || input === "none") return go(st, "main", undefined, ctx);
  const g = st.groups?.[+input - 1];
  if (!g) return go(st, "main", undefined, ctx);
  return openConv(st, ctx, { space: g.space, dm: false, title: g.title });
}
// פתיחת שיחה (קבוצה או פרטית) עם ההודעות האחרונות, גם אם נקראו
async function openConv(st, ctx, sp, filter = "", n = 8) {
  const me = await myUserId(ctx.env);
  let msgs = (await spaceMessages(ctx.env, sp.space, null, filter ? 30 : n)).map((m) => ({ u: m.sender?.name || "", t: msgText(m), mine: m.sender?.name === "users/" + me, media: mediaOf(m), name: m.name || "", atts: attsOf(m) }));
  if (filter) {
    const f = normName(filter);
    const hit = msgs.filter((m) => normName(m.t).includes(f));
    msgs = hit.length ? hit.slice(-8) : msgs.slice(-8);
    sp.note = hit.length ? `${hit.length === 1 ? "הודעה אחת" : hit.length + " הודעות"} עם ${filter}.` : `לא מצאתי הודעות עם ${filter}, הנה האחרונות.`;
  } else msgs = msgs.slice(-n);
  const names = await spaceMembers(ctx.env, sp.space);
  for (const m of msgs) m.n = m.mine ? "אתה" : names[m.u] || (await userName(ctx.env, m.u));
  if (sp.dm && !sp.title) sp.title = Object.entries(names).find(([u]) => u !== "users/" + me)?.[1] || "איש קשר";
  st.conv = { items: [{ ...sp, msgs, recent: true }], i: 0, kind: sp.dm ? "dm" : "group" };
  if (st.share?.fromChat && st.share.back === "files") {
    delete st.share.fromChat;
    const atts = msgs.flatMap((m) => (m.atts || []).map((a) => ({ ...a, from: m.n })));
    if (!atts.length) return go(st, "filesMenu", undefined, ctx, "לא נשלחו קבצים בהודעות האחרונות של השיחה.");
    st.share.srcList = atts.slice(-8); st.share.back = "files";
    return go(st, "sharePickChat", undefined, ctx);
  }
  return go(st, "convItem", undefined, ctx);
}
const attsOf = (m) => (m.attachment || []).map((a) => ({ name: a.contentName || "קובץ", mime: a.contentType || "", res: a.attachmentDataRef?.resourceName || "", drive: a.driveDataRef?.driveFileId || "" }));

function convSpeech(c, idx, total) {
  const head = c.dm
    ? `${total > 1 ? `שיחה ${idx + 1} מתוך ${total}. ` : ""}הודעות מ${c.title}.${c.mention ? " מזכירים אותך." : ""}`
    : `${total > 1 ? `קבוצה ${idx + 1} מתוך ${total}. ` : ""}קבוצת ${c.title}. ${c.recent ? "ההודעות האחרונות" : c.msgs.length === 1 ? "הודעה חדשה אחת" : `${c.msgs.length} הודעות חדשות`}.${c.mention ? " מזכירים אותך." : ""}`;
  const body = c.spoken || c.msgs.slice(-10).map((m) => (c.dm && !m.mine ? m.t : `${m.n} כתב: ${m.t}`)).join(". ");
  return head + (c.note ? " " + c.note : "") + " " + trimText(body, 2500);
}
H.convItem = async (st, input, ctx) => {
  const v = st.conv;
  if (v.i >= v.items.length) return go(st, "main", undefined, ctx, v.kind === "dm" ? "סיימת את ההודעות הפרטיות." : "סיימת את הקבוצות.");
  const c = v.items[v.i];
  st.step = "convMenu";
  if (c.spoken === undefined) {
    const body = c.msgs.slice(-10).map((m) => (c.dm ? m.t : `${m.n} כתב: ${m.t}`)).join("\n");
    c.spoken = isForeign(body) ? "ההודעות באנגלית, הנה תרגום. " + (await toHebrew(ctx.env, body, 1500)) : null;
  }
  return R.msg(convSpeech(c, v.i, v.items.length)) + convMenuRead(st, c);
};
const convMedia = (c) => c.msgs.flatMap((m) => (m.media || []).map((x) => ({ ...x, from: m.n || "" })));
function convMenuRead(st, c, pre = "") {
  const has = convMedia(c).length > 0;
  const p = (pre ? pre + " " : "") + (has ? CONV_MENU.replace("לעוד אפשרויות", "לשמיעת הסרטונים וההקלטות מהשיחה הקש 5. לעוד אפשרויות") : CONV_MENU);
  return R.menu(st, p, has ? "0.1.2.3.4.5.6" : "0.1.2.3.4.6");
}
H.convMenu = async (st, input, ctx) => {
  const v = st.conv, c = v.items[v.i];
  switch (input) {
    case "1": return R.msg(convSpeech(c, v.i, v.items.length)) + convMenuRead(st, c);
    case "5": {
      const media = convMedia(c);
      if (!media.length) return convMenuRead(st, c);
      st.media = { list: media.slice(-8), back: "conv" };
      return go(st, "mediaPick", undefined, ctx);
    }
    case "2":
      st.compose = { kind: "chat", space: c.space, back: "convAfterReply", label: c.dm ? c.title : "קבוצת " + c.title };
      return go(st, "rec", undefined, ctx);
    case "3": v.i++; return go(st, "convItem", undefined, ctx);
    case "4": await chatMarkRead(ctx.env, c.space).catch(() => {}); v.i++; return go(st, "convItem", undefined, ctx, "סומן כנקרא.");
    case "6": return go(st, "convMore", undefined, ctx);
    case "0": return go(st, "main", undefined, ctx);
    default: {
      st.idle = (st.idle || 0) + 1;
      if (st.idle >= 3) return R.msg("להתראות") + R.hangup();
      return convMenuRead(st, c);
    }
  }
};
H.convAfterReply = async (st, input, ctx) => {
  const v = st.conv;
  await chatMarkRead(ctx.env, v.items[v.i].space).catch(() => {});
  if (v.items[v.i].recent) { st.step = "convMenu"; return R.msg("ההודעה נשלחה.") + convMenuRead(st, v.items[v.i]); }
  v.i++;
  return go(st, "convItem", undefined, ctx, "ההודעה נשלחה.");
};

// עוד אפשרויות בשיחה
const convMorePrompt = (c) => `לסיכום השיחה הקש 1. ללייק על ההודעה האחרונה הקש 2. ${c.dm ? "" : "להשתקת הקבוצה הקש 3. להוספת אדם לקבוצה הקש 4. "}לתיקון או מחיקה של ההודעה האחרונה ששלחת הקש 5. לשליחת הודעה קולית הקש 6. לקבצים שנשלחו בשיחה הקש 7. לחזרה הקש 0.`;
H.convMore = async (st, input, ctx) => {
  const env = ctx.env, v = st.conv, c = v.items[v.i];
  const back = (pre = "") => { st.step = "convMenu"; return (pre ? R.msg(pre) : "") + convMenuRead(st, c); };
  if (input === undefined) { st.step = "convMore"; return R.menu(st, convMorePrompt(c), c.dm ? "0.1.2.5.6.7" : "0.1.2.3.4.5.6.7"); }
  switch (input) {
    case "1": {
      const msgs = await spaceMessages(env, c.space, null, 40).catch(() => []);
      const names = await spaceMembers(env, c.space);
      const me = await myUserId(env);
      const text = msgs.map((m) => `${m.sender?.name === "users/" + me ? "אני" : names[m.sender?.name] || "משתתף"}: ${msgText(m)}`).join("\n");
      const sum = await llm(env, "סכם בעברית את השיחה הבאה מהצאט בעד 120 מילים: על מה דיברו, מה הוחלט, ומה מבקשים ממני (אני = שמואל). " + SPOKEN, text, 500).catch(() => "");
      return back(sum || "לא הצלחתי לסכם.");
    }
    case "2": {
      const last = c.msgs.filter((m) => !m.mine && m.name).pop();
      if (!last) return back("אין הודעה לסמן.");
      try { await gapi(env, `${G.chat}${last.name}/reactions`, { body: { emoji: { unicode: "👍" } } }); return back("סומן בלייק."); }
      catch (e) { await logEvent(env, "לייק נכשל: " + e.message); return back("הלייק נכשל."); }
    }
    case "3": {
      if (c.dm) return back();
      const mute = await kvJson(env, "mute", []);
      if (!mute.includes(c.space)) mute.push(c.space);
      await env.KV.put("mute", JSON.stringify(mute));
      v.i++;
      return go(st, "convItem", undefined, ctx, `הקבוצה ${c.title} הושתקה. אפשר לבטל בהגדרות.`);
    }
    case "4": if (c.dm) return back(); return go(st, "addMemberName", undefined, ctx);
    case "5": return go(st, "myLastMsg", undefined, ctx);
    case "6":
      st.compose = { kind: "chat", space: c.space, back: "convAfterReply", label: c.dm ? c.title : "קבוצת " + c.title, audioOnly: true };
      return go(st, "rec", undefined, ctx);
    case "7": {
      const atts = c.msgs.flatMap((m) => (m.atts || []).map((a) => ({ ...a, from: m.n })));
      if (!atts.length) return back("לא נשלחו קבצים בהודעות האלה.");
      st.share = { srcList: atts.slice(-8), back: "conv" };
      return go(st, "sharePickChat", undefined, ctx);
    }
    default: return back();
  }
};
H.addMemberName = async (st, input, ctx) => {
  if (input === undefined) { st.step = "addMemberName"; return R.record(st, "אמור את שם האדם להוספה לקבוצה, ובסיום הקש סולמית."); }
  const c = st.conv.items[st.conv.i];
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) { st.step = "convMenu"; return R.msg(spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.") + convMenuRead(st, c); }
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "addMemberPick";
  return R.menu(st, st.cands.map((x, i) => `להוסיף את ${x.n}${dupName(st.cands, x) ? " בכתובת " + x.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.addMemberPick = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i], x = st.cands?.[+input - 1];
  st.step = "convMenu";
  if (!x) return convMenuRead(st, c);
  try {
    await gapi(ctx.env, `${G.chat}${c.space}/members`, { body: { member: { name: "users/" + x.e, type: "HUMAN" } } });
    await logEvent(ctx.env, `${x.n} נוסף לקבוצה ${c.title}`);
    return R.msg(`${x.n} נוסף לקבוצה.`) + convMenuRead(st, c);
  } catch (e) { await logEvent(ctx.env, "הוספה לקבוצה נכשלה: " + e.message); return R.msg("ההוספה נכשלה. ייתכן שאין לך הרשאה לנהל את הקבוצה.") + convMenuRead(st, c); }
};
// תיקון או מחיקה של ההודעה האחרונה שלי בשיחה
H.myLastMsg = async (st, input, ctx) => {
  const env = ctx.env, c = st.conv.items[st.conv.i];
  if (input === undefined) {
    const me = await myUserId(env);
    const mine = (await spaceMessages(env, c.space, null, 25)).filter((m) => m.sender?.name === "users/" + me).pop();
    if (!mine) { st.step = "convMenu"; return R.msg("לא מצאתי הודעה שלך בשיחה הזו.") + convMenuRead(st, c); }
    st.editMsg = { name: mine.name, text: msgText(mine) };
    st.step = "myLastMsg";
    return R.menu(st, `ההודעה האחרונה שלך: ${st.editMsg.text}. לתיקון בהקלטה מחדש הקש 1. למחיקה הקש 2. לחזרה הקש 0.`, "0.1.2");
  }
  if (input === "1") { st.step = "editMsgRec"; return R.record(st, "אמור את הנוסח החדש של ההודעה, ובסיום הקש סולמית."); }
  if (input === "2") { st.step = "delMsgConfirm"; return R.menu(st, "למחוק את ההודעה? לאישור הקש 1. לביטול הקש 0.", "0.1"); }
  st.step = "convMenu"; return convMenuRead(st, c);
};
H.editMsgRec = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i];
  const t = await transcribeVal(ctx.env, input, "message");
  st.step = "convMenu";
  if (!t) return R.msg("לא שמעתי. ההודעה לא שונתה.") + convMenuRead(st, c);
  st.editMsg.newText = t; st.step = "editMsgConfirm";
  return R.menu(st, `הנוסח החדש: ${t}. לאישור התיקון הקש 1. לביטול הקש 0.`, "0.1");
};
H.editMsgConfirm = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i];
  st.step = "convMenu";
  if (input !== "1") return R.msg("בוטל.") + convMenuRead(st, c);
  try { await gapi(ctx.env, `${G.chat}${st.editMsg.name}?updateMask=text`, { method: "PATCH", body: { text: st.editMsg.newText } }); await logEvent(ctx.env, "הודעת צאט תוקנה: " + st.editMsg.newText); return R.msg("ההודעה תוקנה.") + convMenuRead(st, c); }
  catch (e) { await logEvent(ctx.env, "תיקון הודעה נכשל: " + e.message); return R.msg("התיקון נכשל.") + convMenuRead(st, c); }
};
H.delMsgConfirm = async (st, input, ctx) => {
  const c = st.conv.items[st.conv.i];
  st.step = "convMenu";
  if (input !== "1") return R.msg("בוטל.") + convMenuRead(st, c);
  try { await gapi(ctx.env, `${G.chat}${st.editMsg.name}`, { method: "DELETE" }); await logEvent(ctx.env, "הודעת צאט נמחקה"); return R.msg("ההודעה נמחקה.") + convMenuRead(st, c); }
  catch (e) { return R.msg("המחיקה נכשלה.") + convMenuRead(st, c); }
};

// חיפוש שיחה או הודעה בדיבור: "הקבוצה של השיעור", "מה דוד כתב על החשבונית"
H.chatSearchRec = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "chatSearchRec"; return (pre ? R.msg(pre) : "") + R.record(st, "אמור את שם הקבוצה או האדם, ואם תרצה גם על מה ההודעה. בסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "nav");
  if (!spoken) return go(st, "main", undefined, ctx, "לא שמעתי.");
  return chatSearchRun(st, ctx, spoken);
};
async function chatSearchRun(st, ctx, spoken) {
  const env = ctx.env;
  let j = { who: spoken, keyword: "" };
  try {
    const out = await llm(env, "המשתמש אמר בטלפון איזו שיחה בצאט לפתוח. חלץ JSON בלבד: who (שם הקבוצה או האדם, בלי המילים קבוצה או שיחה), keyword (מילה או שתיים שהוא מחפש בהודעות, או ריק). החזר רק JSON.", spoken, 100);
    j = { ...j, ...JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}") };
  } catch {}
  const who = normName(j.who || spoken);
  const cands = [];
  const mute = await kvJson(env, "mute", []);
  for (const s of (await chatSpaces(env)).filter(isGroup)) {
    const d = normName(s.displayName);
    if (d && who && (d.includes(who) || who.includes(d) || who.split(" ").some((w) => w.length > 2 && d.includes(w)))) cands.push({ space: s.name, dm: false, title: s.displayName, muted: mute.includes(s.name) });
  }
  for (const p of (await findPeople(env, j.who || spoken).catch(() => [])).slice(0, 3)) cands.push({ dm: true, title: p.n, email: p.e });
  if (!cands.length) return go(st, "main", undefined, ctx, `לא מצאתי שיחה או איש קשר בשם ${j.who || spoken}.`);
  st.chatCands = cands.slice(0, 6); st.chatKeyword = j.keyword || "";
  if (st.chatCands.length === 1) return go(st, "chatSearchPick", "1", ctx);
  st.step = "chatSearchPick";
  return R.menu(st, st.chatCands.map((c, i) => `${c.dm ? "שיחה עם " + c.title : "קבוצת " + c.title} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...st.chatCands.map((_, i) => i + 1)].join("."));
}
H.chatSearchPick = async (st, input, ctx) => {
  const c = st.chatCands?.[+input - 1];
  if (!c) return go(st, "main", undefined, ctx);
  if (c.dm) {
    let space = "";
    try { space = await chatDMSpace(ctx.env, c.email, false); } catch {}
    if (!space) return go(st, "main", undefined, ctx, `אין שיחה בצאט עם ${c.title}.`);
    return openConv(st, ctx, { space, dm: true, title: c.title }, st.chatKeyword);
  }
  return openConv(st, ctx, { space: c.space, dm: false, title: c.title }, st.chatKeyword);
};

// ---- הודעה חדשה

H.newStart = async (st, input, ctx) => {
  if (input === undefined) { st.step = "newStart"; return R.menu(st, "לשליחת מייל הקש 1. להודעה בצאט הקש 2. לניסוח מייל עם AI לפי הנחיה קצרה הקש 3. לשמיעת מספר טלפון של איש קשר הקש 4. לחזרה הקש 0.", "0.1.2.3.4"); }
  if (input === "1" || input === "2" || input === "3") { st.newKind = input === "2" ? "chat" : "email"; st.newAi = input === "3"; st.tries = 0; return go(st, "newName", undefined, ctx); }
  if (input === "4") { st.step = "phoneRec"; return R.record(st, "אמור את שם האיש, ובסיום הקש סולמית."); }
  return go(st, "main", undefined, ctx);
};
H.phoneRec = async (st, input, ctx) => {
  const spoken = await transcribeVal(ctx.env, input, "name");
  if (!spoken) return go(st, "newStart", undefined, ctx, "לא שמעתי.");
  return go(st, "newStart", undefined, ctx, await phoneLookup(ctx.env, spoken));
};
H.newName = async (st, input, ctx) => {
  if (input === undefined) { st.step = "newName"; return R.record(st, "אמור את שם האיש אחרי הצליל ובסיום הקש סולמית"); }
  const spoken = await transcribeVal(ctx.env, input, "name");
  if (!spoken) return retryOr(st, ctx, "newName", "לא שמעתי שם.");
  const found = await findPeople(ctx.env, spoken);
  if (!found.length) return retryOr(st, ctx, "newName", `לא מצאתי איש קשר בשם ${spoken}.`);
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "newPick";
  const list = st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ");
  return R.menu(st, list + ". לאמירת השם מחדש הקש 9. לביטול הקש 0.", ["0", "9", ...st.cands.map((_, i) => String(i + 1))].join("."));
};
const dupName = (list, c) => list.filter((x) => x.n === c.n).length > 1;
H.newPick = async (st, input, ctx) => {
  if (input === "9") return go(st, "newName", undefined, ctx);
  const c = st.cands?.[+input - 1];
  if (!c) return go(st, "main", undefined, ctx);
  st.compose = st.newKind === "email"
    ? { kind: "email", to: c.e, back: "main", label: c.n, ai: !!st.newAi }
    : { kind: "chatNew", email: c.e, back: "main", label: c.n };
  delete st.newAi;
  return go(st, "rec", undefined, ctx, st.compose.ai ? `מייל עבור ${c.n}. אמור בקצרה מה לכתוב, ואני אנסח.` : `הודעה עבור ${c.n}.`);
};

// ---- הקלטה, אישור ושליחה (משותף לכל סוגי ההודעות)

async function transcribeVal(env, path, mode = "assistant", keep = false) {
  // null = לא הוקלט כלום (סולמית מיד), "" = הוקלט אבל לא זוהה דיבור. keep = להשאיר את קובץ ההקלטה בימות (לצירוף או לשמירה)
  if (!path || path === "none" || path === "None") return null;
  const audio = await ym(env, "DownloadFile", { path: "ivr2:" + path });
  if (!keep) ym(env, "FileAction", { action: "delete", what: "ivr2:" + path }).catch(() => {});
  if (!audio || audio.length < 2000 || audio[0] === 123) return null;
  return transcribe(env, audio, mode);
}
const ymDelete = (env, path) => ym(env, "FileAction", { action: "delete", what: "ivr2:" + path }).catch(() => {});
function retryOr(st, ctx, step, why) {
  st.tries = (st.tries || 0) + 1;
  if (st.tries >= 3) return go(st, "main", undefined, ctx, why + " חוזרים לתפריט הראשי.");
  return go(st, step, undefined, ctx, why + " נסה שוב.");
}

// ---- הקלטה, אישור ושליחה (משותף לכל סוגי ההודעות)

H.rec = async (st, input, ctx, pre = "") => {
  const cp = st.compose;
  if (input === undefined) { st.step = "rec"; return (pre ? R.msg(pre) : "") + R.record(st, cp.audioOnly ? "הקלט את ההודעה הקולית אחרי הצליל. בסיום הקש סולמית." : REC_PROMPT); }
  if (cp.audio && cp.audio !== input) ymDelete(ctx.env, cp.audio);
  cp.audio = input;
  const t = await transcribeVal(ctx.env, input, cp.ai ? "assistant" : "message", true);
  if (!t) {
    cp.fail = (cp.fail || 0) + 1;
    if (cp.fail >= 3) return go(st, "main", undefined, ctx, "לא הצלחתי לשמוע את ההודעה. חוזרים לתפריט הראשי.");
    return go(st, "rec", undefined, ctx, "לא הצלחתי לשמוע. נסה שוב.");
  }
  if (cp.ai && !cp.append) {
    cp.instruction = t;
    try { cp.text = (await draftWithAi(ctx.env, st, t)).trim(); cp.drafted = true; }
    catch { cp.text = t; }
  } else cp.text = cp.append ? (cp.text + " " + t).trim() : t;
  cp.append = false;
  return go(st, "confirm", undefined, ctx);
};
const confirmPrompt = (cp) => {
  const p = ["לשליחה הקש 1", "להקלטה מחדש הקש 2"];
  if (!cp.audioOnly) p.push("להוספה להודעה הקש 3");
  if (!cp.audioOnly && !cp.translated) p.push("לתרגום לאנגלית לפני השליחה הקש 4");
  if (!cp.audioOnly && cp.audio && (cp.kind === "reply" || cp.kind === "email")) p.push("לצירוף ההקלטה הקולית למייל הקש 5");
  if (!cp.audioOnly && cp.audio && (cp.kind === "chat" || cp.kind === "chatNew")) p.push("לשליחה כהודעה קולית במקום טקסט הקש 5");
  p.push("לביטול הקש 0");
  return p.join(". ") + ".";
};
const confirmKeys = (cp) => "0.1.2" + (cp.audioOnly ? "" : ".3.4.5");
H.confirm = async (st, input, ctx) => {
  const cp = st.compose;
  if (input === undefined) {
    st.step = "confirm";
    const what = cp.audioOnly ? `הודעה קולית עבור ${cp.label}, וזה מה שנאמר בה: ${cp.text}` : `${cp.drafted ? "ניסחתי כך. " : ""}ההודעה עבור ${cp.label}: ${cp.text}${cp.withAudio ? ". ההקלטה הקולית תצורף." : ""}`;
    return R.msg(what) + R.menu(st, confirmPrompt(cp), confirmKeys(cp));
  }
  if (input === "2") { cp.drafted = false; return go(st, "rec", undefined, ctx); }
  if (input === "3" && !cp.audioOnly) { cp.append = true; return go(st, "rec", undefined, ctx); }
  if (input === "4" && !cp.audioOnly && !cp.translated) {
    try {
      cp.orig = cp.text;
      cp.text = (await llm(ctx.env, "תרגם את ההודעה הבאה לאנגלית טבעית ומנומסת. החזר רק את התרגום.", cp.text, 400)).trim();
      cp.translated = true;
    } catch { return R.msg("התרגום נכשל.") + R.menu(st, confirmPrompt(cp), confirmKeys(cp)); }
    return go(st, "confirm", undefined, ctx);
  }
  if (input === "5" && !cp.audioOnly && cp.audio) {
    if (cp.kind === "chat" || cp.kind === "chatNew") cp.audioOnly = true;
    else cp.withAudio = true;
    return go(st, "confirm", undefined, ctx);
  }
  if (input === "1") {
    try {
      await sendCompose(ctx.env, st);
    } catch (e) {
      await logEvent(ctx.env, "שליחה נכשלה: " + e.message);
      return R.msg("השליחה נכשלה. ההודעה לא נשלחה") + R.menu(st, confirmPrompt(cp), confirmKeys(cp));
    }
    if (cp.audio) ymDelete(ctx.env, cp.audio);
    const back = cp.back;
    delete st.compose;
    if (back === "main") { st.lastSent = st.lastSent || null; return go(st, "main", undefined, ctx, "ההודעה נשלחה."); }
    return go(st, back, undefined, ctx, "");
  }
  if (input === "0") { if (cp.audio) ymDelete(ctx.env, cp.audio); delete st.compose; return go(st, "main", undefined, ctx, "ההודעה בוטלה."); }
  return R.menu(st, confirmPrompt(cp), confirmKeys(cp));
};

async function recordingBytes(env, path) {
  const b = await ym(env, "DownloadFile", { path: "ivr2:" + path });
  if (!b || b.length < 100 || b[0] === 123) throw new Error("אין הקלטה");
  return b;
}
async function sendCompose(env, st) {
  const cp = st.compose;
  const att = cp.withAudio && cp.audio ? { name: "הקלטה.wav", mime: "audio/wav", bytes: await recordingBytes(env, cp.audio) } : null;
  if (cp.kind === "reply") {
    const c = st.cur;
    const subject = /^(re|תשובה|השב)\s*:/i.test(c.subject) ? c.subject : "Re: " + c.subject;
    await gmailSend(env, { to: c.replyTo, subject, body: cp.text, threadId: c.threadId, inReplyTo: c.msgId, refs: c.refs, att });
    await logEvent(env, `נשלחה תשובה במייל ל${c.fromName}: ${cp.text}`);
  } else if (cp.kind === "email") {
    let subject = "";
    try { subject = (await llm(env, "כתוב נושא קצר (עד 6 מילים) למייל הבא. החזר רק את הנושא, בלי מירכאות.", cp.text, 40)).split("\n")[0].replace(/["']/g, "").trim(); } catch {}
    if (!subject || subject.length > 80) subject = cp.text.split(/\s+/).slice(0, 6).join(" ");
    await gmailSend(env, { to: cp.to, subject, body: cp.text, att });
    await logEvent(env, `נשלח מייל ל${cp.label} (${cp.to}): ${cp.text}`);
  } else if (cp.kind === "chat" || cp.kind === "chatNew") {
    const space = cp.space || (await chatDMSpace(env, cp.email));
    let m;
    if (cp.audioOnly) m = await chatSendAudio(env, space, await recordingBytes(env, cp.audio), cp.text);
    else m = await chatSend(env, space, cp.text);
    st.lastChat = { space, name: m?.name || "" };
    await logEvent(env, `נשלחה הודעת צאט ל${cp.label}: ${cp.audioOnly ? "(הקלטה קולית) " : ""}${cp.text}`);
  }
}
// שליחת הקלטה בצאט כקובץ שמע (העלאה ואז הודעה עם הקובץ)
async function chatSendAudio(env, space, bytes, caption = "") {
  const b = "b" + randKey(12);
  const head = new TextEncoder().encode(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: "voice-" + Date.now() + ".wav" })}\r\n--${b}\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${b}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
  const r = await fetch(`https://chat.googleapis.com/upload/v1/${space}/attachments:upload?uploadType=multipart`, {
    method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": `multipart/related; boundary=${b}` }, body,
  });
  const j = await r.json().catch(() => ({}));
  // התשובה של media.upload היא { attachmentDataRef: { attachmentUploadToken } }, וכך גם צריך לצרף להודעה
  const tok = j.attachmentDataRef?.attachmentUploadToken || j.attachmentUploadToken;
  if (!r.ok || !tok) throw new Error("chat upload " + r.status + " " + (j.error?.message || ""));
  return gapi(env, `${G.chat}${space}/messages`, { body: { text: caption ? "🎤 " + caption : "🎤 הודעה קולית", attachment: [{ attachmentDataRef: { attachmentUploadToken: tok } }] } });
}

// ---- סיכום

H.summary = async (st, input, ctx) => {
  const env = ctx.env;
  const [prim, upd] = await Promise.all([gmailUnread(env, 12, "primary"), gmailUnread(env, 6, "updates")]);
  const mails = await Promise.all([...prim.map((id) => [id, "ראשי"]), ...upd.map((id) => [id, "עדכונים"])]
    .map(([id, cat]) => gmailGet(env, id).then((m) => ({ ...m, cat })).catch(() => null)));
  let convs = [];
  try { convs = await chatUnread(env, "all"); } catch {}
  if (!mails.filter(Boolean).length && !convs.length) return go(st, "main", undefined, ctx, "אין שום דבר חדש. לא הגיעו מיילים או הודעות.");
  const data = [
    ...mails.filter(Boolean).map((m) => `מייל (${m.cat}) מאת ${m.fromName}, נושא: ${m.subject}. ${trimText(m.body, 600)}`),
    ...convs.map((c) => (c.dm ? `צאט פרטי מ${c.title}: ` : `קבוצת ${c.title}: `) + trimText(c.msgs.map((m) => (c.dm ? m.t : m.n + ": " + m.t)).join(" | "), 700)),
  ].join("\n\n");
  const sum = await llm(env,
    "אתה עוזר אישי. סכם עבורי בעברית את המיילים והודעות הצאט החדשים שלי, עד 150 מילים, גם אם הם כתובים באנגלית. התחל במה שבתיבה הראשית ובמה שדחוף או שמבקשים ממני לעשות, ורק אחר כך בקצרה את העדכונים. ציין שמות של מי שכתב, ושמות באנגלית כתוב באותיות עבריות. אל תמציא פרטים. " + SPOKEN,
    data, 600).catch(() => "");
  return go(st, "main", undefined, ctx, sum || "לא הצלחתי להכין סיכום כרגע.");
};

// ---- החלפת קוד

H.pinNew = async (st, input, ctx) => {
  if (input === undefined) { st.step = "pinNew"; return R.digits(st, "הקש קוד חדש בן 4 עד 8 ספרות ובסיום סולמית. לביטול הקש 0 וסולמית", 1, 8); }
  if (!input || input === "none" || input === "0") return go(st, "main", undefined, ctx);
  if (input.length < 4) return R.msg("הקוד קצר מדי") + R.digits(st, "הקש קוד חדש בן 4 עד 8 ספרות ובסיום סולמית", 1, 8);
  st.newPin = input;
  st.step = "pinNew2";
  return R.digits(st, "הקש את הקוד החדש פעם נוספת לאישור ובסיום סולמית", 4, 8);
};
H.pinNew2 = async (st, input, ctx) => {
  const p = st.newPin;
  delete st.newPin;
  if (input !== p) return go(st, "main", undefined, ctx, "הקודים לא תואמים. הקוד לא הוחלף.");
  await ctx.env.KV.put("pin_hash", await sha(p));
  await logEvent(ctx.env, "הקוד הסודי הוחלף דרך הטלפון");
  return go(st, "main", undefined, ctx, "הקוד הוחלף בהצלחה.");
};

// ================================================================ העוזר החכם
// עוזר קולי עם גישה לחשבון הגוגל. חיפושים רצים מיד; כל פעולה מחכה לאישור (1 לאישור, 2 לחזרה),
// ופעולה בלתי הפיכה (שליחה, מחיקה, יצירת אירוע) מבקשת אישור פעמיים. ההחלטה על אישור כפול נקבעת כאן בקוד, לא על ידי ה-AI.

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/";
const DRIVE = "https://www.googleapis.com/drive/v3/";

function ilOffset(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", timeZoneName: "longOffset" }).formatToParts(d);
  return (p.find((x) => x.type === "timeZoneName")?.value || "GMT+02:00").replace("GMT", "") || "+02:00";
}
function nowIL() {
  const d = new Date();
  const f = (o) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", ...o }).format(d);
  return `${f({ year: "numeric", month: "2-digit", day: "2-digit" })} ${f({ hour: "2-digit", minute: "2-digit", hour12: false })}, ${new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", weekday: "long" }).format(d)}`;
}
const spokenLabels = (t) => String(t).replace(/^\s*(מאת|נושא|תוכן)\s*:\s*/gm, (x, w) => (w === "תוכן" ? "" : w + " ")).replace(/\n+/g, ". ");
const catOf = (labels = []) => labels.includes("CATEGORY_UPDATES") ? "עדכונים" : labels.includes("CATEGORY_PROMOTIONS") ? "קידומי מכירות" : labels.includes("CATEGORY_SOCIAL") ? "רשתות חברתיות" : "ראשי";

async function chatTitle(env, space) {
  try {
    const s = await gapi(env, `${G.chat}${space}`);
    if (!isDM(s)) return "קבוצת " + (s.displayName || "בלי שם");
    const me = await myUserId(env);
    const names = await spaceMembers(env, space);
    return Object.entries(names).find(([u]) => u !== "users/" + me)?.[1] || "איש קשר";
  } catch { return "השיחה"; }
}
async function nameForEmail(env, email) {
  const book = await contactBook(env).catch(() => []);
  return book.find((c) => c.e.toLowerCase() === String(email).toLowerCase())?.n || String(email);
}
async function heb(env, t) { return isForeign(t) ? toHebrew(env, t, 800) : t; }

// ---- חיפושים (רצים בלי אישור)
const LOOKUP = {
  search_email: {
    desc: "חיפוש מיילים בתיבה. מקבל שאילתה בתחביר החיפוש של Gmail (למשל from:(avrahami OR אברהמי), subject:חשבונית, is:unread category:primary, newer_than:7d). מחזיר מזהה, שולח, נושא, תאריך, קטגוריה ותקציר קצר בלבד, לא את התוכן המלא.",
    params: { query: ["STRING", "שאילתת החיפוש"], max: ["INTEGER", "מספר תוצאות, עד 10"] }, req: ["query"],
    async run(env, a) {
      const max = Math.min(10, +a.max || 5);
      const j = await gapi(env, `${G.gmail}messages?q=${encodeURIComponent(a.query || "")}&maxResults=${max}`);
      return Promise.all((j.messages || []).map(async (m) => {
        const x = await gapi(env, `${G.gmail}messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        return { id: m.id, from: header(x, "From"), subject: header(x, "Subject"), date: header(x, "Date"), category: catOf(x.labelIds), unread: (x.labelIds || []).includes("UNREAD"), snippet: (x.snippet || "").slice(0, 160) };
      }));
    },
  },
  search_contacts: {
    desc: "חיפוש איש קשר לפי שם (אפשר שם בעברית גם כשהוא שמור באנגלית). מחזיר שמות וכתובות מייל בלבד. למספרי טלפון השתמש ב-get_contact_details.",
    params: { name: ["STRING", "השם"] }, req: ["name"],
    async run(env, a) { return (await findPeople(env, a.name || "")).map((c) => ({ name: c.n, email: c.e })); },
  },
  list_chats: {
    desc: "רשימת שיחות הצאט (פרטיות וקבוצות) שיש בהן הודעות שלא נקראו: מזהה שיחה, שם, סוג ומספר הודעות חדשות.",
    params: {}, req: [],
    async run(env) { return (await chatUnread(env, "all")).map((c) => ({ space: c.space, name: c.title, type: c.dm ? "פרטי" : "קבוצה", new_messages: c.msgs.length })); },
  },
  find_group: {
    desc: "מציאת קבוצת צאט לפי שם. מחזיר מזהה שיחה ושם.",
    params: { name: ["STRING", "שם הקבוצה או חלק ממנו"] }, req: ["name"],
    async run(env, a) {
      const n = normName(a.name);
      return (await chatSpaces(env)).filter(isGroup).filter((s) => { const d = normName(s.displayName); return d && (d.includes(n) || n.includes(d)); })
        .slice(0, 6).map((s) => ({ space: s.name, name: s.displayName }));
    },
  },
  list_events: {
    desc: "אירועים ביומן בטווח תאריכים: מזהה, כותרת, התחלה, סיום ומיקום.",
    params: { from: ["STRING", "תאריך התחלה YYYY-MM-DD"], to: ["STRING", "תאריך סיום YYYY-MM-DD (כולל)"] }, req: ["from", "to"],
    async run(env, a) {
      // ההפרש משעון UTC לפי התאריך המבוקש (שעון קיץ/חורף), לא לפי היום
      const offFrom = ilOffset(new Date(a.from + "T12:00:00Z")), offTo = ilOffset(new Date(a.to + "T12:00:00Z"));
      const j = await gapi(env, `${CAL}events?singleEvents=true&orderBy=startTime&maxResults=25&timeMin=${encodeURIComponent(a.from + "T00:00:00" + offFrom)}&timeMax=${encodeURIComponent(a.to + "T23:59:59" + offTo)}`);
      return (j.items || []).map((e) => ({ id: e.id, title: e.summary || "", start: e.start?.dateTime || e.start?.date, end: e.end?.dateTime || e.end?.date, location: e.location || "" }));
    },
  },
  search_drive: {
    desc: "חיפוש קבצים בגוגל דרייב לפי מילה בשם הקובץ או בתוכן. מחזיר מזהה, שם, סוג ותאריך שינוי.",
    params: { text: ["STRING", "מילת חיפוש"] }, req: ["text"],
    async run(env, a) {
      const t = String(a.text || "").replace(/\\/g, "").replace(/'/g, "\\'");
      const q = `trashed=false and (name contains '${t}' or fullText contains '${t}')`;
      const j = await gapi(env, `${DRIVE}files?pageSize=8&fields=files(id,name,mimeType,modifiedTime)&q=${encodeURIComponent(q)}`);
      return j.files || [];
    },
  },
};

// ---- פעולות (מחכות לאישור). twice = פעולה בלתי הפיכה, אישור כפול
// שגיאה "רכה" מ-describe: חסר פרט או אין תוצאות. חוזרת למודל כתשובת כלי כדי שישאל או יסביר, במקום "לא מצאתי"
const soft = (msg) => Object.assign(new Error(msg), { soft: true });
const ACTIONS = {
  play_email: {
    desc: "השמעת מייל מלא למשתמש (מתורגם לעברית אם הוא בשפה אחרת).",
    params: { id: ["STRING", "מזהה המייל מתוצאות החיפוש"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `להשמיע את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      let t = `מאת: ${e.fromName}\nנושא: ${e.subject}\nתוכן: ${trimText(e.body, 3500)}`;
      if (isForeign(t)) t = "המייל באנגלית, הנה תרגום. " + (await toHebrew(env, t, 2500));
      return spokenLabels(t);
    },
  },
  summarize_email: {
    desc: "סיכום קצר של מייל.",
    params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `לסכם את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      return llm(env, "סכם את המייל בשניים שלושה משפטים בעברית. ציין אם מבקשים ממני משהו ועד מתי. " + SPOKEN, `מאת: ${e.fromName}\nנושא: ${e.subject}\n\n${e.body}`, 400);
    },
  },
  mark_email_read: {
    desc: "סימון מייל כנקרא.", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `לסמן כנקרא את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) { await gmailMarkRead(env, a.id); return "המייל סומן כנקרא."; },
  },
  archive_email: {
    desc: "העברת מייל לארכיון (הוצאה מתיבת הדואר הנכנס).", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `להעביר לארכיון את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) { await gapi(env, `${G.gmail}messages/${a.id}/modify`, { body: { removeLabelIds: ["INBOX", "UNREAD"] } }); return "המייל הועבר לארכיון."; },
  },
  trash_email: {
    twice: true, desc: "מחיקת מייל (העברה לאשפה).", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return heb(env, `למחוק את המייל מ${e.fromName} בנושא ${e.subject}`); },
    async run(env, a) { await gapi(env, `${G.gmail}messages/${a.id}/trash`, { method: "POST" }); return "המייל נמחק."; },
  },
  reply_email: {
    twice: true, desc: "שליחת תשובה למייל. הגוף הוא בדיוק מה שהמשתמש ביקש לכתוב.",
    params: { id: ["STRING", "מזהה המייל שעונים עליו"], body: ["STRING", "תוכן התשובה"] }, req: ["id", "body"],
    async describe(env, a) { const e = await gmailGet(env, a.id); return `לשלוח תשובה ל${await heb(env, e.fromName)} על המייל בנושא ${await heb(env, e.subject)}. תוכן התשובה: ${a.body}`; },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      const subject = /^(re|תשובה|השב)\s*:/i.test(e.subject) ? e.subject : "Re: " + e.subject;
      await gmailSend(env, { to: e.replyTo, subject, body: a.body, threadId: e.threadId, inReplyTo: e.msgId, refs: e.refs });
      return "התשובה נשלחה.";
    },
  },
  send_email: {
    twice: true, desc: "שליחת מייל חדש. את כתובת הנמען מוצאים קודם עם search_contacts.",
    params: { to: ["STRING", "כתובת המייל של הנמען"], subject: ["STRING", "נושא"], body: ["STRING", "תוכן המייל"] }, req: ["to", "subject", "body"],
    async describe(env, a) { return `לשלוח מייל אל ${await heb(env, await nameForEmail(env, a.to))} בנושא ${a.subject}. תוכן המייל: ${a.body}`; },
    async run(env, a) { await gmailSend(env, { to: a.to, subject: a.subject, body: a.body }); return "המייל נשלח."; },
  },
  play_chat: {
    desc: "השמעת ההודעות האחרונות בשיחת צאט.", params: { space: ["STRING", "מזהה השיחה (spaces/...)"] }, req: ["space"],
    async describe(env, a) { return `להשמיע את ההודעות האחרונות ב${await heb(env, await chatTitle(env, a.space))}`; },
    async run(env, a) {
      const me = await myUserId(env);
      const names = await spaceMembers(env, a.space);
      const msgs = await spaceMessages(env, a.space, null, 10);
      let t = msgs.map((m) => `${m.sender?.name === "users/" + me ? "אתה" : names[m.sender?.name] || "משתתף"} כתב: ${msgText(m)}`).join("\n");
      if (!t) return "אין הודעות בשיחה הזו.";
      if (isForeign(t)) t = "ההודעות באנגלית, הנה תרגום. " + (await toHebrew(env, t, 1500));
      return t;
    },
  },
  send_chat: {
    twice: true, desc: "שליחת הודעה בצאט: לשיחה קיימת (space) או לאדם לפי כתובת מייל (to_email, שמוצאים עם search_contacts).",
    params: { space: ["STRING", "מזהה שיחה קיימת, אם יש"], to_email: ["STRING", "כתובת מייל של אדם, אם אין מזהה שיחה"], text: ["STRING", "תוכן ההודעה"] }, req: ["text"],
    async describe(env, a) {
      if (!a.space && !a.to_email) throw soft("חסר נמען: צריך מזהה שיחה (space) או כתובת מייל של האדם (to_email).");
      const who = a.space ? await chatTitle(env, a.space) : await nameForEmail(env, a.to_email);
      return `לשלוח הודעה בצאט אל ${await heb(env, who)}. תוכן ההודעה: ${a.text}`;
    },
    async run(env, a) {
      const space = a.space || (await chatDMSpace(env, a.to_email));
      await chatSend(env, space, a.text);
      return "ההודעה נשלחה.";
    },
  },
  read_drive_file: {
    desc: "הקראת תוכן של מסמך מהדרייב (מסמך גוגל או קובץ טקסט).", params: { id: ["STRING", "מזהה הקובץ"] }, req: ["id"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return heb(env, `להקריא את הקובץ ${f.name}`); },
    async run(env, a) {
      const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name,mimeType`);
      const tok = await accessToken(env);
      let url;
      if (f.mimeType === "application/vnd.google-apps.document" || f.mimeType === "application/vnd.google-apps.presentation") url = `${DRIVE}files/${a.id}/export?mimeType=text/plain`;
      else if (f.mimeType === "application/vnd.google-apps.spreadsheet") url = `${DRIVE}files/${a.id}/export?mimeType=text/csv`;
      else if (/^text\//.test(f.mimeType)) url = `${DRIVE}files/${a.id}?alt=media`;
      else return "אי אפשר להקריא קובץ מהסוג הזה בטלפון.";
      const r = await fetch(url, { headers: { Authorization: "Bearer " + tok } });
      if (!r.ok) return "לא הצלחתי לפתוח את הקובץ.";
      let t = trimText(await r.text(), 3000);
      if (isForeign(t)) t = "הקובץ באנגלית, הנה תרגום. " + (await toHebrew(env, t, 2500));
      return t || "הקובץ ריק.";
    },
  },
  create_event: {
    twice: true, desc: "יצירת אירוע ביומן. אם יש משתתפים, הם יקבלו הזמנה במייל.",
    params: { title: ["STRING", "כותרת"], start: ["STRING", "התחלה YYYY-MM-DDTHH:MM (שעון ישראל)"], end: ["STRING", "סיום YYYY-MM-DDTHH:MM (שעון ישראל)"], attendees: ["STRING", "כתובות מייל של משתתפים מופרדות בפסיק (לא חובה)"] }, req: ["title", "start", "end"],
    async describe(env, a) {
      const fmt = (s) => String(s).replace("T", " בשעה ");
      return `ליצור ביומן אירוע בשם ${a.title}, מתאריך ${fmt(a.start)} עד ${fmt(a.end)}${a.attendees ? ", ולשלוח הזמנה למשתתפים" : ""}`;
    },
    async run(env, a) {
      const ev = { summary: a.title, start: { dateTime: a.start.length === 16 ? a.start + ":00" : a.start, timeZone: "Asia/Jerusalem" }, end: { dateTime: a.end.length === 16 ? a.end + ":00" : a.end, timeZone: "Asia/Jerusalem" } };
      const att = String(a.attendees || "").split(",").map((x) => x.trim()).filter((x) => x.includes("@"));
      if (att.length) ev.attendees = att.map((email) => ({ email }));
      await gapi(env, `${CAL}events?sendUpdates=all`, { body: ev });
      return "האירוע נוצר ביומן.";
    },
  },
  delete_event: {
    twice: true, desc: "מחיקת אירוע מהיומן.", params: { id: ["STRING", "מזהה האירוע"] }, req: ["id"],
    async describe(env, a) { const e = await gapi(env, `${CAL}events/${a.id}`); return heb(env, `למחוק מהיומן את האירוע ${e.summary || ""} שמתחיל ב ${String(e.start?.dateTime || e.start?.date || "").slice(0, 16).replace("T", " בשעה ")}`); },
    async run(env, a) { await gapi(env, `${CAL}events/${a.id}?sendUpdates=all`, { method: "DELETE" }); return "האירוע נמחק מהיומן."; },
  },
};

// ---- יכולות נוספות: משימות, מסמכים, גיליונות, אנשי קשר, תוויות, העברה, מענה אוטומטי, שיתוף, Meet
const TASKS = "https://tasks.googleapis.com/tasks/v1/";
const DOCS = "https://docs.googleapis.com/v1/documents";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";

async function gmailLabelId(env, name, create = false) {
  const j = await gapi(env, `${G.gmail}labels`);
  const found = (j.labels || []).find((l) => l.name.toLowerCase() === String(name).toLowerCase());
  if (found) return found.id;
  if (!create) throw new Error("תווית לא קיימת");
  return (await gapi(env, `${G.gmail}labels`, { body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } })).id;
}
async function emailLine(env, id) { const e = await gmailGet(env, id); return heb(env, `המייל מ${e.fromName} בנושא ${e.subject}`); }
const modifyEmail = (env, id, add = [], remove = []) => gapi(env, `${G.gmail}messages/${id}/modify`, { body: { addLabelIds: add, removeLabelIds: remove } });

Object.assign(LOOKUP, {
  list_tasks: {
    desc: "רשימת המשימות הפתוחות ב-Google Tasks: מזהה, כותרת ותאריך יעד.",
    params: {}, req: [],
    async run(env) {
      const j = await gapi(env, `${TASKS}lists/@default/tasks?showCompleted=false&maxResults=30`);
      return (j.items || []).map((t) => ({ id: t.id, title: t.title, due: t.due || "", notes: (t.notes || "").slice(0, 100) }));
    },
  },
  list_labels: {
    desc: "רשימת התוויות (תיקיות) שיש בתיבת המייל.",
    params: {}, req: [],
    async run(env) { return ((await gapi(env, `${G.gmail}labels`)).labels || []).filter((l) => l.type === "user").map((l) => l.name); },
  },
  get_auto_reply: {
    desc: "בדיקה אם המענה האוטומטי (חופשה/היעדרות) במייל פעיל ומה הוא אומר.",
    params: {}, req: [],
    async run(env) {
      const v = await gapi(env, `${G.gmail}settings/vacation`);
      return { on: !!v.enableAutoReply, subject: v.responseSubject || "", message: (v.responseBodyPlainText || "").slice(0, 300), until: v.endTime ? new Date(+v.endTime).toISOString() : "" };
    },
  },
});

Object.assign(ACTIONS, {
  mark_email_unread: {
    desc: "סימון מייל כלא נקרא.", params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async describe(env, a) { return `לסמן כלא נקרא את ${await emailLine(env, a.id)}`; },
    async run(env, a) { await modifyEmail(env, a.id, ["UNREAD"]); return "המייל סומן כלא נקרא."; },
  },
  star_email: {
    desc: "סימון מייל בכוכב (או הסרת הכוכב).", params: { id: ["STRING", "מזהה המייל"], remove: ["BOOLEAN", "true כדי להסיר את הכוכב"] }, req: ["id"],
    async describe(env, a) { return `${a.remove ? "להסיר את הכוכב מ" : "לסמן בכוכב את "}${await emailLine(env, a.id)}`; },
    async run(env, a) { await (a.remove ? modifyEmail(env, a.id, [], ["STARRED"]) : modifyEmail(env, a.id, ["STARRED"])); return a.remove ? "הכוכב הוסר." : "המייל סומן בכוכב."; },
  },
  restore_email: {
    desc: "שחזור מייל מהאשפה.", params: { id: ["STRING", "מזהה המייל (חיפוש עם in:trash)"] }, req: ["id"],
    async describe(env, a) { return `לשחזר מהאשפה את ${await emailLine(env, a.id)}`; },
    async run(env, a) { await gapi(env, `${G.gmail}messages/${a.id}/untrash`, { method: "POST" }); return "המייל שוחזר מהאשפה."; },
  },
  label_email: {
    desc: "הוספת תווית (תיקייה) למייל. אם התווית לא קיימת, היא תיווצר.", params: { id: ["STRING", "מזהה המייל"], label: ["STRING", "שם התווית"] }, req: ["id", "label"],
    async describe(env, a) { return `להוסיף את התווית ${a.label} ל${await emailLine(env, a.id)}`; },
    async run(env, a) { await modifyEmail(env, a.id, [await gmailLabelId(env, a.label, true)]); return `התווית ${a.label} נוספה למייל.`; },
  },
  forward_email: {
    twice: true, desc: "העברת מייל (כולל הקבצים המצורפים) לאדם אחר, עם הערה קצרה. את הכתובת מוצאים עם search_contacts.",
    params: { id: ["STRING", "מזהה המייל"], to: ["STRING", "כתובת המייל של הנמען"], note: ["STRING", "הערה קצרה שתופיע מעל המייל (לא חובה)"] }, req: ["id", "to"],
    async describe(env, a) { return `להעביר את ${await emailLine(env, a.id)} אל ${await heb(env, await nameForEmail(env, a.to))}${a.note ? `, עם ההערה: ${a.note}` : ""}`; },
    async run(env, a) {
      const e = await gmailGet(env, a.id);
      const raw = await gapi(env, `${G.gmail}messages/${a.id}?format=raw`);
      const original = unb64url(raw.raw); // נשאר בייטים: מייל מקורי בקידוד windows-1255 היה נהרס במעבר דרך מחרוזת UTF-8
      const b = "fwd" + randKey(16);
      const subject = /^(fwd?|הועבר)\s*:/i.test(e.subject) ? e.subject : "Fwd: " + e.subject;
      const head = new TextEncoder().encode([`To: ${a.to}`, `Subject: ${encHeader(subject)}`, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${b}"`, "",
        `--${b}`, 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", utf8b64(a.note || "מצורף מייל שהועבר.").replace(/(.{76})/g, "$1\r\n"),
        `--${b}`, "Content-Type: message/rfc822", 'Content-Disposition: attachment; filename="forwarded.eml"', "", ""].join("\r\n"));
      const tail = new TextEncoder().encode(`\r\n--${b}--\r\n`);
      const msg = new Uint8Array(head.length + original.length + tail.length);
      msg.set(head); msg.set(original, head.length); msg.set(tail, head.length + original.length);
      if (msg.length > 4e6) {
        // מייל גדול (קבצים מצורפים): העלאת הבייטים ישירות, לא דרך JSON (שמוגבל לכמה מגה)
        const r = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", { method: "POST", headers: { Authorization: "Bearer " + (await accessToken(env)), "Content-Type": "message/rfc822" }, body: msg });
        if (!r.ok) throw new Error("gmail upload " + r.status + " " + ((await r.json().catch(() => ({}))).error?.message || ""));
      } else await gapi(env, `${G.gmail}messages/send`, { body: { raw: b64(msg).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") } });
      return "המייל הועבר.";
    },
  },
  set_auto_reply: {
    twice: true, desc: "הפעלה או כיבוי של מענה אוטומטי במייל (למשל בזמן היעדרות). כשמפעילים, כל מי ששולח מייל יקבל את ההודעה.",
    params: { on: ["BOOLEAN", "true להפעלה, false לכיבוי"], subject: ["STRING", "נושא ההודעה האוטומטית"], message: ["STRING", "תוכן ההודעה האוטומטית"], until: ["STRING", "עד איזה תאריך YYYY-MM-DD (לא חובה)"] }, req: ["on"],
    async describe(env, a) {
      if (a.on && !String(a.message || "").trim()) throw soft("חסר תוכן להודעה האוטומטית. שאל את המשתמש מה לכתוב.");
      return a.on ? `להפעיל מענה אוטומטי במייל${a.until ? ` עד ${a.until}` : ""}, עם ההודעה: ${a.message || ""}` : "לכבות את המענה האוטומטי במייל";
    },
    async run(env, a) {
      if (!a.on) {
        // כיבוי: שומרים את הנוסח הקיים (PUT מחליף את כל ההגדרה)
        const cur = await gapi(env, `${G.gmail}settings/vacation`).catch(() => ({}));
        await gapi(env, `${G.gmail}settings/vacation`, { method: "PUT", body: { ...cur, enableAutoReply: false } });
        return "המענה האוטומטי כובה.";
      }
      const body = { enableAutoReply: true, responseSubject: a.subject || "", responseBodyPlainText: a.message || "", restrictToContacts: false, restrictToDomain: false };
      if (a.until) body.endTime = String(Date.parse(a.until + "T23:59:59" + ilOffset(new Date(a.until + "T12:00:00Z"))));
      await gapi(env, `${G.gmail}settings/vacation`, { method: "PUT", body });
      return "המענה האוטומטי הופעל.";
    },
  },
  add_task: {
    desc: "הוספת משימה ל-Google Tasks.", params: { title: ["STRING", "המשימה"], due: ["STRING", "תאריך יעד YYYY-MM-DD (לא חובה)"], notes: ["STRING", "פרטים (לא חובה)"] }, req: ["title"],
    async describe(env, a) { return `להוסיף משימה: ${a.title}${a.due ? `, עד ${a.due}` : ""}`; },
    async run(env, a) {
      const t = { title: a.title, notes: a.notes || undefined };
      if (a.due) t.due = a.due + "T00:00:00.000Z";
      await gapi(env, `${TASKS}lists/@default/tasks`, { body: t });
      return "המשימה נוספה.";
    },
  },
  complete_task: {
    desc: "סימון משימה כבוצעה.", params: { id: ["STRING", "מזהה המשימה מ-list_tasks"] }, req: ["id"],
    async describe(env, a) { const t = await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`); return `לסמן כבוצעה את המשימה: ${t.title}`; },
    async run(env, a) { await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`, { method: "PATCH", body: { status: "completed" } }); return "המשימה סומנה כבוצעה."; },
  },
  delete_task: {
    twice: true, desc: "מחיקת משימה.", params: { id: ["STRING", "מזהה המשימה"] }, req: ["id"],
    async describe(env, a) { const t = await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`); return `למחוק את המשימה: ${t.title}`; },
    async run(env, a) { await gapi(env, `${TASKS}lists/@default/tasks/${a.id}`, { method: "DELETE" }); return "המשימה נמחקה."; },
  },
  create_contact: {
    desc: "הוספת איש קשר חדש.", params: { name: ["STRING", "שם מלא"], email: ["STRING", "מייל (לא חובה)"], phone: ["STRING", "טלפון (לא חובה)"] }, req: ["name"],
    async describe(env, a) { return `להוסיף איש קשר בשם ${a.name}${a.phone ? `, טלפון ${a.phone.split("").join(" ")}` : ""}${a.email ? `, מייל ${a.email}` : ""}`; },
    async run(env, a) {
      const p = { names: [{ unstructuredName: a.name }] };
      if (a.email) p.emailAddresses = [{ value: a.email }];
      if (a.phone) p.phoneNumbers = [{ value: a.phone }];
      await gapi(env, `${G.people}people:createContact`, { body: p });
      await env.KV.delete("contacts").catch(() => {});
      return "איש הקשר נוסף.";
    },
  },
  create_doc: {
    desc: "יצירת מסמך גוגל חדש עם טקסט (למשל רשימה או סיכום שהמשתמש מכתיב).", params: { title: ["STRING", "שם המסמך"], text: ["STRING", "התוכן"] }, req: ["title", "text"],
    async describe(env, a) { return `ליצור מסמך חדש בשם ${a.title}, עם התוכן: ${trimText(a.text, 400)}`; },
    async run(env, a) {
      const d = await gapi(env, DOCS, { body: { title: a.title } });
      await gapi(env, `${DOCS}/${d.documentId}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: 1 }, text: a.text } }] } });
      return { say: "המסמך נוצר בדרייב.", mem: `מזהה המסמך: ${d.documentId}` };
    },
  },
  append_to_doc: {
    desc: "הוספת טקסט לסוף מסמך גוגל קיים.", params: { id: ["STRING", "מזהה המסמך מ-search_drive"], text: ["STRING", "הטקסט להוספה"] }, req: ["id", "text"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `להוסיף לסוף המסמך ${await heb(env, f.name)} את הטקסט: ${trimText(a.text, 400)}`; },
    async run(env, a) {
      const d = await gapi(env, `${DOCS}/${a.id}?fields=body(content(endIndex))`);
      const end = Math.max(1, (d.body?.content || []).reduce((m, c) => Math.max(m, c.endIndex || 1), 1) - 1);
      await gapi(env, `${DOCS}/${a.id}:batchUpdate`, { body: { requests: [{ insertText: { location: { index: end }, text: "\n" + a.text } }] } });
      return "הטקסט נוסף למסמך.";
    },
  },
  read_sheet: {
    desc: "קריאת נתונים מגיליון גוגל (Sheets).", params: { id: ["STRING", "מזהה הגיליון מ-search_drive"], range: ["STRING", "טווח, למשל A1:F20 (לא חובה)"] }, req: ["id"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `להקריא נתונים מהגיליון ${await heb(env, f.name)}`; },
    async run(env, a) {
      const j = await gapi(env, `${SHEETS}${a.id}/values/${encodeURIComponent(a.range || "A1:H25")}`);
      const rows = (j.values || []).map((r) => r.join(", "));
      return rows.length ? llm(env, "הקרא בעברית את הנתונים מהטבלה בצורה ברורה לשמיעה בטלפון, שורה אחרי שורה, בקצרה. " + SPOKEN, rows.join("\n"), 800) : "הגיליון ריק בטווח הזה.";
    },
  },
  add_sheet_row: {
    desc: "הוספת שורה לסוף גיליון גוגל.", params: { id: ["STRING", "מזהה הגיליון"], values: ["STRING", "ערכי השורה מופרדים בפסיק"] }, req: ["id", "values"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `להוסיף לגיליון ${await heb(env, f.name)} שורה עם: ${a.values}`; },
    async run(env, a) {
      await gapi(env, `${SHEETS}${a.id}/values/A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { body: { values: [String(a.values).split(",").map((x) => x.trim())] } });
      return "השורה נוספה לגיליון.";
    },
  },
  share_drive_file: {
    twice: true, desc: "שיתוף קובץ מהדרייב עם אדם (הוא יקבל מייל הודעה).", params: { id: ["STRING", "מזהה הקובץ"], email: ["STRING", "מייל של מי שמשתפים איתו"], edit: ["BOOLEAN", "true להרשאת עריכה, אחרת צפייה בלבד"] }, req: ["id", "email"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `לשתף את הקובץ ${await heb(env, f.name)} עם ${await heb(env, await nameForEmail(env, a.email))}, ${a.edit ? "עם הרשאת עריכה" : "לצפייה בלבד"}`; },
    async run(env, a) { await gapi(env, `${DRIVE}files/${a.id}/permissions?sendNotificationEmail=true`, { body: { role: a.edit ? "writer" : "reader", type: "user", emailAddress: a.email } }); return "הקובץ שותף."; },
  },
  trash_drive_file: {
    twice: true, desc: "מחיקת קובץ מהדרייב (העברה לאשפה).", params: { id: ["STRING", "מזהה הקובץ"] }, req: ["id"],
    async describe(env, a) { const f = await gapi(env, `${DRIVE}files/${a.id}?fields=name`); return `למחוק מהדרייב את הקובץ ${await heb(env, f.name)}`; },
    async run(env, a) { await gapi(env, `${DRIVE}files/${a.id}`, { method: "PATCH", body: { trashed: true } }); return "הקובץ נמחק."; },
  },
  update_event: {
    twice: true, desc: "שינוי אירוע קיים ביומן (שעה, כותרת). משתתפים יקבלו עדכון.",
    params: { id: ["STRING", "מזהה האירוע"], title: ["STRING", "כותרת חדשה (לא חובה)"], start: ["STRING", "התחלה חדשה YYYY-MM-DDTHH:MM (לא חובה)"], end: ["STRING", "סיום חדש YYYY-MM-DDTHH:MM (לא חובה)"] }, req: ["id"],
    async describe(env, a) {
      const e = await gapi(env, `${CAL}events/${a.id}`);
      const fmt = (s) => String(s).slice(0, 16).replace("T", " בשעה ");
      return `לשנות ביומן את האירוע ${await heb(env, e.summary || "")}${a.title ? `, לשם ${a.title}` : ""}${a.start ? `, לזמן ${fmt(a.start)}${a.end ? ` עד ${fmt(a.end)}` : ""}` : ""}`;
    },
    async run(env, a) {
      const p = {};
      if (a.title) p.summary = a.title;
      const dt = (s) => ({ dateTime: s.length === 16 ? s + ":00" : s, timeZone: "Asia/Jerusalem" });
      if (a.start) p.start = dt(a.start);
      if (a.end) p.end = dt(a.end);
      if (a.start && !a.end) {
        // רק שעת התחלה חדשה: שומרים על אורך האירוע, אחרת גוגל דוחה התחלה שאחרי הסיום הישן
        const e = await gapi(env, `${CAL}events/${a.id}`);
        const dur = Date.parse(e.end?.dateTime || "") - Date.parse(e.start?.dateTime || "");
        const startMs = Date.parse(p.start.dateTime + ilOffset(new Date(p.start.dateTime + "Z")));
        if (dur > 0 && startMs) p.end = { dateTime: new Date(startMs + dur).toISOString(), timeZone: "Asia/Jerusalem" };
      }
      await gapi(env, `${CAL}events/${a.id}?sendUpdates=all`, { method: "PATCH", body: p });
      return "האירוע עודכן.";
    },
  },
  create_meet: {
    desc: "יצירת קישור לפגישת Google Meet חדשה (אפשר אחר כך לשלוח אותו במייל או בצאט).", params: {}, req: [],
    async describe() { return "ליצור קישור לפגישת מיט חדשה"; },
    async run(env) { const m = await gapi(env, "https://meet.googleapis.com/v2/spaces", { body: {} }); return { say: "נוצר קישור לפגישת מיט. אפשר לבקש ממני לשלוח אותו במייל או בצאט.", mem: `הקישור: ${m.meetingUri}` }; },
  },
});

// ---- עוד יכולות: פעולות על הרבה מיילים, טיוטות, קבצים מצורפים, זמנים פנויים, הזמנות, פרטי אנשי קשר, פתקים
async function gmailIds(env, q, max = 500) {
  let ids = [], tok = "";
  while (ids.length < max) {
    const j = await gapi(env, `${G.gmail}messages?q=${encodeURIComponent(q)}&maxResults=500${tok ? "&pageToken=" + tok : ""}`);
    ids = ids.concat((j.messages || []).map((m) => m.id));
    if (!(tok = j.nextPageToken)) break;
  }
  return ids.slice(0, max);
}
const BULK_MAX = 5000; // פעולות על הרבה מיילים: עד כאן בבת אחת (ולא 500 בשקט כאילו זה הכל)
const batchModify = (env, ids, add = [], remove = []) => gapi(env, `${G.gmail}messages/batchModify`, { body: { ids, addLabelIds: add, removeLabelIds: remove } });
const countWord = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
function attachmentsOf(payload) {
  const out = [];
  const walk = (p) => { if (!p) return; if (p.filename && p.body?.attachmentId && !isInlineImage(p)) out.push({ name: p.filename, mime: p.mimeType, id: p.body.attachmentId, size: p.body.size || 0 }); (p.parts || []).forEach(walk); };
  walk(payload);
  return out;
}

Object.assign(LOOKUP, {
  search_youtube: {
    desc: "חיפוש סרטונים ביוטיוב. מחזיר מזהה, כותרת, ערוץ ואורך.",
    params: { query: ["STRING", "מה לחפש"] }, req: ["query"],
    async run(env, a) {
      const j = await ytGet(env, `search?part=snippet&type=video&maxResults=6&q=${encodeURIComponent(a.query)}`);
      const ids = (j.items || []).map((v) => v.id?.videoId).filter(Boolean);
      const info = await ytTitles(env, ids);
      return ids.map((id) => ({ id, title: info[id]?.title || "", channel: info[id]?.channel || "", length: ytDur(info[id]?.dur || "") }));
    },
  },
  get_contact_details: {
    desc: "פרטי איש קשר לפי שם: טלפונים, מיילים וחברה.",
    params: { name: ["STRING", "השם"] }, req: ["name"],
    async run(env, a) {
      const out = [];
      const add = (p) => out.push({ name: p.names?.[0]?.displayName || "", phones: (p.phoneNumbers || []).map((x) => x.value), emails: (p.emailAddresses || []).map((x) => x.value), company: p.organizations?.[0]?.name || "" });
      await gapi(env, `${G.people}people:searchContacts?query=&readMask=names`).catch(() => {});
      const j = await gapi(env, `${G.people}people:searchContacts?query=${encodeURIComponent(a.name)}&readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=8`).catch(() => ({}));
      (j.results || []).forEach((r) => add(r.person));
      const d = await gapi(env, `${G.people}people:searchDirectoryPeople?query=${encodeURIComponent(a.name)}&readMask=names,emailAddresses,phoneNumbers,organizations&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`).catch(() => ({}));
      (d.people || []).forEach(add);
      if (!out.length) return (await findPeople(env, a.name)).map((c) => ({ name: c.n, emails: [c.e] }));
      return out.slice(0, 8);
    },
  },
  count_emails: {
    desc: "ספירת מיילים לפי חיפוש (למשל כמה מיילים לא נקראו בעדכונים: is:unread category:updates).",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async run(env, a) { const n = (await gmailIds(env, a.query, 1000)).length; return { count: n, more_than: n >= 1000 }; },
  },
  list_attachments: {
    desc: "רשימת הקבצים המצורפים למייל.",
    params: { id: ["STRING", "מזהה המייל"] }, req: ["id"],
    async run(env, a) { const m = await gapi(env, `${G.gmail}messages/${a.id}?format=full`); return attachmentsOf(m.payload).map((x, i) => ({ index: i + 1, name: x.name, type: x.mime, kb: Math.round(x.size / 1024) })); },
  },
  list_drafts: {
    desc: "רשימת טיוטות המייל: מזהה, נמען ונושא.",
    params: {}, req: [],
    async run(env) {
      const j = await gapi(env, `${G.gmail}drafts?maxResults=10`);
      return Promise.all((j.drafts || []).map(async (d) => {
        const x = await gapi(env, `${G.gmail}drafts/${d.id}?format=metadata`);
        return { id: d.id, to: header(x.message, "To"), subject: header(x.message, "Subject") };
      }));
    },
  },
  find_free_time: {
    desc: "הזמנים התפוסים ביומן בתאריך מסוים, כדי למצוא מתי המשתמש פנוי.",
    params: { date: ["STRING", "תאריך YYYY-MM-DD"] }, req: ["date"],
    async run(env, a) {
      const off = ilOffset(new Date(a.date + "T12:00:00Z"));
      const j = await gapi(env, "https://www.googleapis.com/calendar/v3/freeBusy", { body: { timeMin: `${a.date}T07:00:00${off}`, timeMax: `${a.date}T23:00:00${off}`, timeZone: "Asia/Jerusalem", items: [{ id: "primary" }] } });
      return { busy: (j.calendars?.primary?.busy || []).map((b) => ({ from: b.start, to: b.end })), note: "השעות בפורמט עם אזור זמן; השעות הפנויות הן מה שבין התפוסים, בין 7:00 ל-23:00" };
    },
  },
  list_invitations: {
    desc: "הזמנות לאירועים ביומן שעדיין לא הגבתי עליהן (ב-30 הימים הקרובים).",
    params: {}, req: [],
    async run(env) {
      const j = await gapi(env, `${CAL}events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin=${encodeURIComponent(new Date().toISOString())}&timeMax=${encodeURIComponent(new Date(Date.now() + 30 * 86400e3).toISOString())}`);
      return (j.items || []).filter((e) => (e.attendees || []).some((x) => x.self && x.responseStatus === "needsAction"))
        .map((e) => ({ id: e.id, title: e.summary || "", start: e.start?.dateTime || e.start?.date, organizer: e.organizer?.displayName || e.organizer?.email || "" }));
    },
  },
  list_recent_files: {
    desc: "הקבצים האחרונים ששונו בדרייב.",
    params: {}, req: [],
    async run(env) { return ((await gapi(env, `${DRIVE}files?pageSize=10&orderBy=modifiedTime desc&q=${encodeURIComponent("trashed=false")}&fields=files(id,name,mimeType,modifiedTime)`)).files || []); },
  },
  list_notes: {
    desc: "הפתקים שהמשתמש ביקש ממך לזכור בשיחות קודמות.",
    params: {}, req: [],
    async run(env) { return (await kvJson(env, "notes", [])).map((n) => ({ id: n.id, text: n.t, saved: n.d })); },
  },
});

Object.assign(ACTIONS, {
  listen_youtube: {
    desc: "שמיעת סרטון יוטיוב בטלפון במילים: תקציר או תמלול מלא בעברית (את השמע המקורי של יוטיוב אי אפשר להשמיע). את המזהה מוצאים עם search_youtube, או מקישור שהמשתמש קיבל.",
    params: { id: ["STRING", "מזהה הסרטון (11 תווים)"], mode: ["STRING", "summary לתקציר או full לתמלול מלא"] }, req: ["id"],
    async describe(env, a) { const t = (await ytTitles(env, [a.id]))[a.id]; return `${a.mode === "full" ? "להקריא תמלול מלא בעברית של" : "לשמוע תקציר של"} הסרטון ${t ? await heb(env, t.title) : ""}${t?.dur ? `, באורך ${ytDur(t.dur)}` : ""}`; },
    async run() { return ""; },
  },
  mark_all_read: {
    desc: "סימון הרבה מיילים כנקראו בבת אחת לפי חיפוש (למשל כל העדכונים: is:unread category:updates).",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async describe(env, a) { const n = (await gmailIds(env, a.query + " is:unread", BULK_MAX)).length; if (!n) throw soft("אין מיילים שלא נקראו שמתאימים לחיפוש הזה."); return `לסמן כנקראו ${countWord(n, "מייל אחד", "מיילים")}${n >= BULK_MAX ? " (החלק הראשון)" : ""} לפי החיפוש ${a.query}`; },
    async run(env, a) { const ids = await gmailIds(env, a.query + " is:unread", BULK_MAX); for (let i = 0; i < ids.length; i += 1000) await batchModify(env, ids.slice(i, i + 1000), [], ["UNREAD"]); return `${countWord(ids.length, "מייל אחד סומן", "מיילים סומנו")} כנקראו.`; },
  },
  archive_many: {
    desc: "העברת הרבה מיילים לארכיון בבת אחת לפי חיפוש.",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async describe(env, a) { const n = (await gmailIds(env, a.query + " in:inbox", BULK_MAX)).length; if (!n) throw soft("אין מיילים בתיבה שמתאימים לחיפוש הזה."); return `להעביר לארכיון ${countWord(n, "מייל אחד", "מיילים")}${n >= BULK_MAX ? " (החלק הראשון)" : ""} לפי החיפוש ${a.query}`; },
    async run(env, a) { const ids = await gmailIds(env, a.query + " in:inbox", BULK_MAX); for (let i = 0; i < ids.length; i += 1000) await batchModify(env, ids.slice(i, i + 1000), [], ["INBOX"]); return `${countWord(ids.length, "מייל אחד הועבר", "מיילים הועברו")} לארכיון.`; },
  },
  trash_many: {
    twice: true, desc: "מחיקת הרבה מיילים בבת אחת לפי חיפוש (העברה לאשפה).",
    params: { query: ["STRING", "שאילתת חיפוש בתחביר Gmail"] }, req: ["query"],
    async describe(env, a) { const n = (await gmailIds(env, a.query, BULK_MAX)).length; if (!n) throw soft("אין מיילים שמתאימים לחיפוש הזה."); return `למחוק ${countWord(n, "מייל אחד", "מיילים")}${n >= BULK_MAX ? " (החלק הראשון)" : ""} לפי החיפוש ${a.query}`; },
    async run(env, a) { const ids = await gmailIds(env, a.query, BULK_MAX); for (let i = 0; i < ids.length; i += 1000) await batchModify(env, ids.slice(i, i + 1000), ["TRASH"], ["INBOX"]); return `${countWord(ids.length, "מייל אחד נמחק", "מיילים נמחקו")}.`; },
  },
  read_attachment: {
    desc: "הקראה או סיכום של קובץ מצורף למייל (PDF, תמונה, מסמך טקסט). את מספר הקובץ לוקחים מ-list_attachments.",
    params: { id: ["STRING", "מזהה המייל"], index: ["INTEGER", "מספר הקובץ ברשימה (ברירת מחדל 1)"], mode: ["STRING", "summary לסיכום או full להקראה מלאה"] }, req: ["id"],
    async describe(env, a) {
      const m = await gapi(env, `${G.gmail}messages/${a.id}?format=full`);
      const att = attachmentsOf(m.payload)[(+a.index || 1) - 1];
      if (!att) throw soft("אין קובץ מצורף במספר הזה. בדוק עם list_attachments.");
      return `${a.mode === "full" ? "להקריא" : "לסכם"} את הקובץ המצורף ${await heb(env, att.name)}`;
    },
    async run(env, a) {
      const m = await gapi(env, `${G.gmail}messages/${a.id}?format=full`);
      const att = attachmentsOf(m.payload)[(+a.index || 1) - 1];
      if (!att) return "לא מצאתי את הקובץ.";
      if (att.size > 12e6) return "הקובץ גדול מדי להקראה בטלפון.";
      const data = (await gapi(env, `${G.gmail}messages/${a.id}/attachments/${att.id}`)).data.replace(/-/g, "+").replace(/_/g, "/");
      const mime = /pdf|image\/|text\//.test(att.mime) ? att.mime : /\.pdf$/i.test(att.name) ? "application/pdf" : att.mime;
      if (!/pdf|image\/|text\//.test(mime)) return "אי אפשר להקריא קובץ מהסוג הזה בטלפון.";
      if (!env.GEMINI_KEY) return "הקראת קבצים לא זמינה כרגע.";
      return geminiCall(env, [
        { text: (a.mode === "full" ? "הקרא בעברית את התוכן של הקובץ, בצורה ברורה לשמיעה בטלפון. אם הוא בשפה אחרת, תרגם לעברית. " : "סכם בעברית את הקובץ: במה מדובר, הפרטים החשובים (סכומים, תאריכים, שמות), ומה מבקשים ממני. ") + SPOKEN },
        { inline_data: { mime_type: mime, data } },
      ], 2000, Date.now() + 90000); // רץ ברקע (משימת DO), לכן מותר לו יותר זמן מקריאה רגילה
    },
  },
  create_draft: {
    desc: "שמירת מייל כטיוטה בלי לשלוח אותו.",
    params: { to: ["STRING", "כתובת הנמען"], subject: ["STRING", "נושא"], body: ["STRING", "תוכן"] }, req: ["to", "subject", "body"],
    async describe(env, a) { return `לשמור טיוטה של מייל אל ${await heb(env, await nameForEmail(env, a.to))} בנושא ${a.subject}. התוכן: ${a.body}`; },
    async run(env, a) {
      const raw = [`To: ${a.to}`, `Subject: ${encHeader(a.subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", utf8b64(a.body)].join("\r\n");
      await gapi(env, `${G.gmail}drafts`, { body: { message: { raw: b64url(raw) } } });
      return "הטיוטה נשמרה.";
    },
  },
  send_draft: {
    twice: true, desc: "שליחת טיוטה קיימת. את המזהה לוקחים מ-list_drafts.",
    params: { id: ["STRING", "מזהה הטיוטה"] }, req: ["id"],
    async describe(env, a) { const x = await gapi(env, `${G.gmail}drafts/${a.id}?format=metadata`); return heb(env, `לשלוח את הטיוטה אל ${header(x.message, "To")} בנושא ${header(x.message, "Subject")}`); },
    async run(env, a) { await gapi(env, `${G.gmail}drafts/send`, { body: { id: a.id } }); return "הטיוטה נשלחה."; },
  },
  respond_invitation: {
    twice: true, desc: "תגובה להזמנה לאירוע ביומן: אישור הגעה, סירוב או אולי. המארגן יקבל את התשובה.",
    params: { id: ["STRING", "מזהה האירוע"], response: ["STRING", "accepted לאישור, declined לסירוב, tentative לאולי"] }, req: ["id", "response"],
    async describe(env, a) {
      const e = await gapi(env, `${CAL}events/${a.id}`);
      const word = { accepted: "לאשר הגעה", declined: "לסרב", tentative: "לענות אולי" }[a.response] || "להגיב";
      return heb(env, `${word} להזמנה ${e.summary || ""} של ${e.organizer?.displayName || e.organizer?.email || ""}`);
    },
    async run(env, a) {
      const e = await gapi(env, `${CAL}events/${a.id}`);
      const attendees = (e.attendees || []).map((x) => (x.self ? { ...x, responseStatus: a.response } : x));
      await gapi(env, `${CAL}events/${a.id}?sendUpdates=all`, { method: "PATCH", body: { attendees } });
      return "התשובה להזמנה נשלחה.";
    },
  },
  save_note: {
    desc: "שמירת פתק שהמשתמש מבקש שתזכור (למשל מספר, סיסמה לשער, דבר לזכור). נשמר גם לשיחות הבאות.",
    params: { text: ["STRING", "מה לזכור"] }, req: ["text"],
    async describe(env, a) { return `לשמור פתק: ${a.text}`; },
    async run(env, a) {
      const n = await kvJson(env, "notes", []);
      n.push({ id: randKey(6), t: a.text, d: nowIL() });
      await env.KV.put("notes", JSON.stringify(n.slice(-100)));
      return "הפתק נשמר.";
    },
  },
  delete_note: {
    desc: "מחיקת פתק שמור. את המזהה לוקחים מ-list_notes.",
    params: { id: ["STRING", "מזהה הפתק"] }, req: ["id"],
    async describe(env, a) { const n = (await kvJson(env, "notes", [])).find((x) => x.id === a.id); if (!n) throw soft("אין פתק עם המזהה הזה. בדוק עם list_notes."); return `למחוק את הפתק: ${n.t}`; },
    async run(env, a) { const n = await kvJson(env, "notes", []); await env.KV.put("notes", JSON.stringify(n.filter((x) => x.id !== a.id))); return "הפתק נמחק."; },
  },
});

// תפריט בחירה: כשיש ספק, העוזר מציג אפשרויות ממוספרות והמשתמש בוחר במקש
const ASK_CHOICE = {
  name: "ask_choice",
  description: "[תפריט שאלה] הצגת שאלה עם אפשרויות ממוספרות שהמשתמש בוחר בהן במקש בטלפון. השתמש בזה בכל פעם שיש ספק מה המשתמש התכוון, כשיש כמה התאמות (כמה מיילים, כמה אנשים בשם דומה, כמה אירועים), או כשחסר פרט ויש כמה אפשרויות סבירות. כל אפשרות צריכה להיות קצרה וברורה (עד 12 מילים), עם הפרטים שמבדילים בין האפשרויות.",
  parameters: {
    type: "OBJECT",
    properties: {
      question: { type: "STRING", description: "השאלה, קצרה" },
      options: { type: "ARRAY", items: { type: "STRING" }, description: "בין 2 ל-8 אפשרויות" },
    },
    required: ["question", "options"],
  },
};
function toolDecls() {
  const all = { ...LOOKUP, ...ACTIONS };
  return [ASK_CHOICE].concat(Object.entries(all).map(([name, t]) => ({
    name,
    description: (ACTIONS[name] ? "[פעולה שדורשת אישור מהמשתמש] " : "[חיפוש] ") + t.desc,
    // כלי בלי פרמטרים נשלח בלי parameters: סכמת OBJECT עם properties ריק נדחית על ידי Gemini (400) ומפילה את כל השיחה
    ...(Object.keys(t.params).length ? {
      parameters: {
        type: "OBJECT",
        properties: Object.fromEntries(Object.entries(t.params).map(([k, [type, description]]) => [k, { type, description }])),
        required: t.req,
      },
    } : {}),
  })));
}

function aiSystem(env, mem = "") {
  return `${mem ? "זיכרון משיחות קודמות (לשימושך, אל תקריא אותו סתם):\n" + mem + "\n\n" : ""}אתה העוזר האישי הקולי והחכם של שמואל, שמדבר איתו בטלפון. יש לך גישה לחשבון הגוגל העסקי שלו (${env.BUSINESS_EMAIL}): מייל (קטגוריות ראשי ועדכונים, תוויות, כוכבים, העברה, מענה אוטומטי, טיוטות, קבצים מצורפים ופעולות על הרבה מיילים בבת אחת), צאט, יומן (כולל זמנים פנויים והזמנות), יוטיוב (חיפוש ושמיעת סרטון במילים: תקציר או תמלול), דרייב, מסמכים וגיליונות, משימות (Google Tasks), אנשי קשר עם טלפונים, קישורי Meet, ופתקים שהמשתמש ביקש שתזכור. יש לך גם חיפוש באינטרנט (web_search) לשאלות כלליות, חדשות, שעות וזמנים.
בתחילת שיחה, אם המשתמש שואל על משהו שאולי ביקש ממך לזכור, בדוק ב-list_notes.
השעה עכשיו בישראל: ${nowIL()}.
חשוב: הבקשות שלך מגיעות מתמלול אוטומטי של דיבור בטלפון, ולכן ייתכנו בהן שגיאות: מילה שנשמעה דומה במקום המילה הנכונה, שם שנכתב קצת אחרת, מספרים או שעות שנכתבו בצורה מוזרה, או חוסר בפיסוק.
- הבן את הכוונה הסבירה ביותר לפי ההקשר, ולא לפי המילים המדויקות. למשל "תשמיע לי את המייל מאברהם" יכול להיות אברהמי, ו"בשלוש" יכול להיות 15:00.
- כשמחפשים אדם לפי שם, חפש גם צורות דומות של השם (search_contacts כבר מחפש התאמה חלקית) ואם צריך חפש שוב בצורה אחרת לפני שאתה אומר שלא מצאת.
- בתוכן של הודעה שהמשתמש מכתיב, תקן רק שגיאות תמלול ברורות (מילה שלא מתאימה למשפט), בלי לשנות את המשמעות.
- בכל פעם שיש לך ספק מה המשתמש התכוון, או שיש כמה התאמות אפשריות (כמה מיילים, כמה אנשים בשם דומה, כמה אירועים), אל תנחש: פתח תפריט עם ask_choice, עם אפשרויות ממוספרות וברורות שמבדילות ביניהן (למשל שם מלא, נושא, תאריך). אם יש רק פירוש סביר אחד, המשך, כי המשתמש ישמע את הפרטים ויאשר לפני הביצוע.
- מותר תמיד לפתוח תפריט שאלה עם ask_choice גם כדי לברר פרט חסר (למשל לאיזה יום, לחצי שעה או לשעה, איזה מסמך).
- אם הבקשה עמומה ואין בשיחה הקשר שמבהיר אותה (למשל "תמחק את זה" בלי שדיברנו על משהו), פתח קודם תפריט עם ask_choice שמציע את הפירושים הסבירים, במקום לחפש לפי ניחוש.
כללים:
- ענה תמיד בעברית, בצורה מלאה, מדויקת ומפורטת כמה שצריך כדי לענות באמת על הבקשה: כלול את הפרטים החשובים (שמות, תאריכים, שעות, מספרים, מה מבקשים ממנו). אל תמציא פרטים שלא מצאת. כי התשובה מוקראת בטלפון, כתוב במשפטים ברורים, בלי רשימות, כוכביות, סימנים או אימוג'י. שמות באנגלית כתוב באותיות עבריות.
- מותר לך להשתמש בכלי החיפוש בחופשיות כדי למצוא מידע, ולספר למשתמש מה מצאת (למשל ממי הגיעו מיילים ובאיזה נושא, או מה יש ביומן).
- כדי להשמיע תוכן מלא או לבצע כל פעולה (השמעה, סיכום, שליחה, תשובה, מחיקה, ארכיון, יצירת אירוע) חובה לקרוא לכלי הפעולה המתאים. המערכת תשאל את המשתמש אם לאשר. לעולם אל תגיד שפעולה בוצעה, אלא אם בהיסטוריה כתוב שהיא בוצעה.
- הצע פעולה אחת בכל פעם.
- כשמחפשים מייל לפי שם אדם, חפש גם בכתיב העברי וגם בכתיב האנגלי, למשל from:(avrahami OR אברהמי). אם יש כמה התאמות, בחר את האחרונה שמתאימה לבקשה, או שאל את המשתמש איזו.
- בשליחת הודעות, כתוב בדיוק את מה שהמשתמש ביקש לומר, רק עם תיקון קל של ניסוח. אל תמציא תוכן. אם חסר נמען או תוכן, שאל.
- את כתובת המייל של אדם מוצאים עם search_contacts. אם יש כמה אנשים מתאימים, שאל איזה.
- אם המשתמש ביקש לבטל, לא לבצע, או לחזור, פשוט ענה בקצרה.`;
}

async function geminiTools(env, sys, contents, deadline = Date.now() + 30000) {
  const all = (env.AGENT_MODELS || "gemini-3.8-flash,gemini-flash-latest,gemini-flash-lite-latest").split(",").map((s) => s.trim());
  const models = all.filter((m) => !isBusy(m)).concat(all.filter(isBusy));
  let last = "";
  for (const m of models) {
    const left = deadline - Date.now();
    if (left < 1500) { last = last || "timeout"; break; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents, tools: [{ functionDeclarations: toolDecls() }], generationConfig: { temperature: 0.3, maxOutputTokens: 2000 } }),
        signal: AbortSignal.timeout(Math.min(14000, left)),
      });
      const j = await r.json();
      const parts = j?.candidates?.[0]?.content?.parts;
      bump(env, "gemini");
      if (parts?.length) return parts;
      markBusy(m, j);
      if (j?.error?.code === 429) bump(env, "quota");
      last = JSON.stringify(j).slice(0, 200);
    } catch (e) { last = e.message; if (e.name === "TimeoutError") geminiBusy.set(m, Date.now() + 60e3); }
  }
  throw new Error("agent: " + last);
}

// תור אחד של שיחה עם העוזר: מריץ חיפושים עד שיש תשובה או הצעה לפעולה
async function aiTurn(env, history, userText) {
  const deadline = Date.now() + 22000;
  const sys = aiSystem(env, (await env.KV.get("ai:mem")) || "");
  // Gemini דורש תורות מתחלפות: מאחדים תורות רצופות של אותו צד
  const contents = [];
  for (const h of [...history, { r: "user", t: userText }]) {
    const last = contents[contents.length - 1];
    if (last && last.role === h.r) last.parts[0].text += "\n" + h.t;
    else contents.push({ role: h.r, parts: [{ text: h.t }] });
  }
  if (contents[0]?.role === "model") contents.shift();
  for (let i = 0; i < 6; i++) {
    if (Date.now() > deadline) return { kind: "say", text: "זה לוקח יותר מדי זמן. נסה לבקש שוב בצורה פשוטה יותר." };
    const parts = await geminiTools(env, sys, contents, deadline + 8000);
    const call = parts.find((p) => p.functionCall)?.functionCall;
    if (!call) {
      const text = parts.map((p) => p.text || "").join(" ").trim();
      return { kind: "say", text: text || "לא הבנתי, אפשר לומר שוב?" };
    }
    const { name } = call, args = call.args || {};
    if (name === "ask_choice") {
      const options = (Array.isArray(args.options) ? args.options : String(args.options || "").split("|")).map((o) => String(o).trim()).filter(Boolean).slice(0, 8);
      if (options.length >= 2) return { kind: "choice", question: String(args.question || "למה התכוונת?"), options };
      return { kind: "say", text: String(args.question || "לא הבנתי, אפשר לומר שוב?") };
    }
    if (ACTIONS[name]) {
      let desc;
      try { desc = await ACTIONS[name].describe(env, args); }
      catch (e) {
        if (e.soft) {
          contents.push({ role: "model", parts });
          contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result: { error: e.message } } } }] });
          continue;
        }
        return { kind: "say", text: "לא מצאתי את מה שביקשת. אפשר לנסות שוב בניסוח אחר." };
      }
      return { kind: "confirm", action: { name, args }, desc, twice: !!ACTIONS[name].twice };
    }
    contents.push({ role: "model", parts });
    let result;
    try { result = LOOKUP[name] ? await LOOKUP[name].run(env, args) : { error: "כלי לא קיים" }; }
    catch (e) { result = { error: e.message }; }
    contents.push({ role: "user", parts: [{ functionResponse: { name, response: { result } } }] });
    if (Date.now() > deadline) return { kind: "say", text: "זה לוקח יותר מדי זמן. נסה לבקש שוב בצורה פשוטה יותר." };
  }
  return { kind: "say", text: "לא הצלחתי להשלים את הבקשה. נסה לנסח אותה אחרת." };
}

// תור של העוזר כמשימת רקע: job = { type: "ai", path | chosen | text, history }. מחזיר את התוצאה (בלי לכתוב ל-DO)
async function aiJobResult(env, job) {
  const { path, history = [], chosen = "", text = "" } = job;
  let user = "";
  try {
    if (chosen) user = chosen;
    else if (text) user = text;
    else {
      user = await transcribeVal(env, path, "assistant");
      if (user === null) return { kind: "exit" };
      if (!user) return { kind: "empty" };
    }
    const res = await aiTurn(env, history, chosen ? `(בחרתי בתפריט את האפשרות: ${chosen})` : "(תמלול של מה שאמרתי) " + user);
    return { user, ...res };
  } catch (e) {
    await logEvent(env, "שגיאה בעוזר החכם: " + e.message);
    return { user, kind: "say", text: "הייתה תקלה. נסה שוב." };
  }
}
// תוצאת פעולה: מחרוזת, או { say, mem } כשיש פרט (קישור, מזהה) שהמודל צריך לזכור אבל אין טעם להקריא
const resultSpoken = (r) => String(r?.say ?? r ?? "בוצע.");
const resultMemo = (r) => (r?.mem ? `${resultSpoken(r)} ${r.mem}` : resultSpoken(r));
// פעולה ארוכה של העוזר (קובץ מצורף גדול, מאות מיילים) כמשימת רקע
const SLOW_ACTIONS = new Set(["read_attachment", "mark_all_read", "archive_many", "trash_many"]);
async function actionJobResult(env, job) {
  try {
    const out = await ACTIONS[job.name].run(env, job.args);
    if (job.desc) await logEvent(env, `העוזר החכם ביצע באישור: ${job.desc}`);
    return { kind: "action", ok: true, text: resultSpoken(out), memo: resultMemo(out), desc: job.desc || "" };
  } catch (e) {
    await logEvent(env, `פעולת העוזר נכשלה (${job.name}): ${e.message}`);
    return { kind: "action", ok: false, text: job.name === "read_attachment" ? "לא הצלחתי לקרוא את הקובץ." : "הפעולה נכשלה ולא בוצעה.", desc: job.desc || "" };
  }
}
// כל משימות הרקע (מדיה, הקלטה לדרייב, תור של העוזר, פעולה ארוכה)
async function runJob(env, job) {
  if (job.type === "ai") return aiJobResult(env, job);
  if (job.type === "action") return actionJobResult(env, job);
  return runMediaJob(env, job);
}
// הפעלת משימת רקע. ב-Cloudflare היא רצה בתוך ה-Durable Object (alarm) שמותר לו לרוץ עד 15 דקות,
// ולא ב-waitUntil של ה-Worker, שנקטע אחרי 30 שניות (ואז המתקשר היה שומע "לא הצלחתי לקבל תשובה בזמן")
async function startBgJob(ctx, id, job) {
  const env = ctx.env, callId = ctx.q.ApiCallId || "nocall";
  if (env.CALLS) { await stub(env, callId).fetch("https://do/startjob", { method: "POST", body: JSON.stringify({ id, job }) }); return; }
  await setJob(env, callId, { id, status: "run" });
  const p = runJob(env, job).catch(() => ({ kind: "say", text: job.type === "ai" ? "הייתה תקלה. נסה שוב." : "לא הצלחתי." })).then((res) => setJob(env, callId, { id, status: "done", ...res }));
  ctx.ctx?.waitUntil?.(p);
}

const AI_LISTEN = "דבר אחרי הצליל ובסיום הקש סולמית. ליציאה, הקש סולמית בלי לומר כלום.";
const pushHist = (st, r, t) => { st.ai.h.push({ r, t: String(t).slice(0, 1500) }); st.ai.h = st.ai.h.slice(-14); };

H.aiStart = async (st, input, ctx) => {
  if (!ctx.env.GEMINI_KEY) return go(st, "main", undefined, ctx, "העוזר החכם עדיין לא מוגדר.");
  st.ai = { h: [] };
  return go(st, "aiListen", undefined, ctx, "שלום, אני העוזר החכם. אפשר לבקש ממני כל דבר בחשבון הגוגל שלך, וכל פעולה אבצע רק אחרי שתאשר.");
};
H.aiListen = async (st, input, ctx, pre = "") => {
  st.step = "aiRec";
  return (pre ? R.msg(pre) : "") + R.record(st, st.ai.h.length ? "עוד משהו? " + AI_LISTEN : AI_LISTEN);
};
function aiExit(st, ctx) {
  const h = st.ai?.h || [];
  delete st.ai;
  if (h.length >= 2) ctx.ctx?.waitUntil?.(updateAiMemory(ctx.env, h));
  return go(st, "main", undefined, ctx, "יצאת מהעוזר החכם.");
}
H.aiRec = async (st, input, ctx) => {
  if (!input || input === "none") return aiExit(st, ctx);
  const jobId = "j" + st.n;
  st.ai.job = jobId;
  st.ai.polls = 0;
  await startBgJob(ctx, jobId, { type: "ai", path: input, history: st.ai.h });
  st.step = "aiWait";
  return aiWaitPrompt(st, "רגע, אני בודק");
};
// המתנה עם מנגינה: כל בדיקה משמיעה קטע של 4 שניות (שלושה קטעים שממשיכים זה את זה, בלולאה)
const HOLD_DIR = "/Hold/wait";
function aiWaitPrompt(st, text = "") {
  st.ai.music = ((st.ai.music || 0) % 3) + 1;
  const v = nextVal(st);
  const msgs = (text ? sp(text, "m") + "." : "") + `f-${HOLD_DIR}${st.ai.music}`;
  return `read=${msgs}=${v},no,1,1,1,No,yes,no,,,,Ok,none,`;
}
H.aiWait = async (st, input, ctx) => {
  const job = await getJob(ctx.env, ctx.q.ApiCallId || "nocall");
  if (!job || job.id !== st.ai.job || job.status !== "done") {
    st.ai.polls++;
    if (st.ai.polls > 14) return go(st, "aiListen", undefined, ctx, "לא הצלחתי לקבל תשובה בזמן. נסה שוב.");
    return aiWaitPrompt(st);
  }
  if (job.kind === "exit") return aiExit(st, ctx);
  if (job.kind === "empty") return go(st, "aiListen", undefined, ctx, "לא שמעתי. נסה שוב.");
  if (job.kind === "action") {
    pushHist(st, "user", job.ok ? `(אישרתי. בוצע: ${job.desc}. התוצאה: ${String(job.memo || job.text).slice(0, 300)})` : `(הפעולה נכשלה: ${job.desc})`);
    return go(st, "aiListen", undefined, ctx, job.text);
  }
  pushHist(st, "user", job.user);
  if (job.kind === "say") {
    pushHist(st, "model", job.text);
    return go(st, "aiListen", undefined, ctx, job.text);
  }
  if (job.kind === "choice") {
    st.ai.choice = job.options;
    pushHist(st, "model", `(שאלתי: ${job.question} האפשרויות: ${job.options.map((o, i) => `${i + 1}. ${o}`).join(" ")})`);
    st.step = "aiChoice";
    return R.msg(job.question) + R.menu(st, choicePrompt(job.options), "0." + job.options.map((_, i) => i + 1).join("."));
  }
  st.ai.pending = { action: job.action, desc: job.desc, twice: job.twice, stage: 1 };
  pushHist(st, "model", `(הצעתי לבצע: ${job.desc}. מחכה לאישור)`);
  st.step = "aiConfirm";
  return R.msg(job.desc) + R.menu(st, "לאישור הקש 1. לחזרה לשיחה הקש 2.", "1.2");
};
const choicePrompt = (opts) => opts.map((o, i) => `${o}: הקש ${i + 1}`).join(". ") + ". אם זה לא אחד מאלה, הקש 0 ואמור שוב.";
H.aiChoice = async (st, input, ctx) => {
  const opts = st.ai.choice || [];
  const pick = opts[+input - 1];
  if (!pick) {
    if (input === "none") return R.menu(st, choicePrompt(opts), "0." + opts.map((_, i) => i + 1).join("."));
    delete st.ai.choice;
    return go(st, "aiListen", undefined, ctx, "בסדר, אמור שוב מה תרצה.");
  }
  delete st.ai.choice;
  const jobId = "j" + st.n;
  st.ai.job = jobId;
  st.ai.polls = 0;
  await startBgJob(ctx, jobId, { type: "ai", history: st.ai.h, chosen: pick });
  st.step = "aiWait";
  return aiWaitPrompt(st, "בחרת " + pick);
};
H.aiConfirm = async (st, input, ctx) => {
  const p = st.ai.pending;
  if (!p) return go(st, "aiListen", undefined, ctx);
  if (input !== "1") {
    delete st.ai.pending;
    pushHist(st, "user", `(לא אישרתי את הפעולה: ${p.desc})`);
    return go(st, "aiListen", undefined, ctx, "הפעולה לא בוצעה.");
  }
  if (p.twice && p.stage === 1) {
    p.stage = 2;
    return R.msg("שים לב, את הפעולה הזו אי אפשר לבטל אחרי הביצוע.") + R.menu(st, "לאישור סופי הקש 1. לחזרה לשיחה הקש 2.", "1.2");
  }
  delete st.ai.pending;
  if (SLOW_ACTIONS.has(p.action.name)) {
    // פעולה ארוכה: רצה ברקע עם מנגינת המתנה, במקום לחכות בתוך הבקשה של ימות (שלא מחכה הרבה)
    const jobId = "j" + st.n;
    st.ai.job = jobId; st.ai.polls = 0;
    await startBgJob(ctx, jobId, { type: "action", name: p.action.name, args: p.action.args, desc: p.desc });
    st.step = "aiWait";
    return aiWaitPrompt(st, "רגע, מבצע");
  }
  if (p.action.name === "listen_youtube") {
    pushHist(st, "user", `(אישרתי: ${p.desc})`);
    st.media = { back: "ai" };
    return startMediaJob(ctx, st, { type: "youtube", id: p.action.args.id, mode: p.action.args.mode === "full" ? "full" : "summary" });
  }
  let out;
  try {
    const res = await ACTIONS[p.action.name].run(ctx.env, p.action.args);
    out = resultSpoken(res);
    pushHist(st, "user", `(אישרתי. בוצע: ${p.desc}. התוצאה: ${resultMemo(res).slice(0, 300)})`);
    await logEvent(ctx.env, `העוזר החכם ביצע באישור: ${p.desc}`);
  } catch (e) {
    await logEvent(ctx.env, `פעולת העוזר נכשלה (${p.action.name}): ${e.message}`);
    pushHist(st, "user", `(הפעולה נכשלה: ${p.desc})`);
    out = "הפעולה נכשלה ולא בוצעה.";
  }
  return go(st, "aiListen", undefined, ctx, out);
};

// ================================================================ סרטונים והקלטות (מהצאט ומיוטיוב)
// קובץ מהצאט: מורידים, מעלים לימות עם המרה לשמע, ומשמיעים. יוטיוב: Gemini צופה בסרטון ומחזיר תקציר או תמלול בעברית
// (את השמע המקורי של יוטיוב אי אפשר להוריד ולהשמיע). ההכנה רצה ברקע ב-Durable Object, והמתקשר שומע מנגינת המתנה.
const YT_API = "https://www.googleapis.com/youtube/v3/";
// יוטיוב: עם מפתח API (YT_KEY) אם הוגדר, אחרת עם ההרשאה של החשבון (דורשת youtube.readonly בחיבור לגוגל)
async function ytGet(env, path) {
  if (env.YT_KEY) {
    const r = await fetch(`${YT_API}${path}&key=${encodeURIComponent(env.YT_KEY)}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`youtube ${r.status}: ${j?.error?.message || ""}`.slice(0, 300));
    return j;
  }
  return gapi(env, `${YT_API}${path}`);
}
async function ytTitles(env, ids) {
  if (!ids.length) return {};
  try {
    const j = await ytGet(env, `videos?part=snippet,contentDetails&id=${ids.join(",")}`);
    return Object.fromEntries((j.items || []).map((v) => [v.id, { title: v.snippet?.title || "", channel: v.snippet?.channelTitle || "", dur: v.contentDetails?.duration || "" }]));
  } catch { return {}; }
}
const ytDur = (d) => { const m = String(d).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); if (!m) return ""; const h = +m[1] || 0, mi = +m[2] || 0; return h ? `${h} שעות ו ${mi} דקות` : mi ? `${mi} דקות` : "פחות מדקה"; };

async function runMediaJob(env, job) {
  if (job.type === "recsave") return runRecSave(env, job);
  if (job.type === "file") {
    const key = (await sha(job.res || job.drive)).slice(0, 16);
    const file = "/Media/" + key;
    if (await env.KV.get("media:" + key)) return { kind: "play", file };
    const url = job.res ? `${G.chat}media/${job.res.split("/").map(encodeURIComponent).join("/")}?alt=media` : `${DRIVE}files/${job.drive}?alt=media`;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + (await accessToken(env)) } });
    if (!r.ok) throw new Error("download " + r.status);
    const len = +r.headers.get("content-length") || 0;
    if (len > 45e6) return { kind: "say", text: "הקובץ גדול מדי להשמעה בטלפון." };
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 45e6) return { kind: "say", text: "הקובץ גדול מדי להשמעה בטלפון." };
    const fd = new FormData();
    fd.append("token", env.YM_TOKEN);
    fd.append("path", `ivr2:${file}.wav`);
    fd.append("convertAudio", "1");
    fd.append("file", new Blob([bytes], { type: job.mime || "application/octet-stream" }), job.name || "media.mp4");
    const u = await (await fetch(YM + "UploadFile", { method: "POST", body: fd })).json();
    if (u.responseStatus !== "OK") throw new Error("upload: " + (u.message || u.responseStatus));
    await env.KV.put("media:" + key, "1", { expirationTtl: 30 * 86400 });
    return { kind: "play", file };
  }
  if (job.type === "youtube") {
    if (!env.GEMINI_KEY) return { kind: "say", text: "השמעת סרטוני יוטיוב לא זמינה כרגע." };
    const ck = `yt:${job.id}:${job.mode}`;
    const c = await env.KV.get(ck);
    if (c) return { kind: "say", text: c };
    const prompt = job.mode === "full"
      ? "כתוב בעברית את כל מה שנאמר בסרטון, מההתחלה ועד הסוף, כמו תמלול מלא. אם הדיבור בשפה אחרת, תרגם לעברית. אל תתאר מה רואים, רק מה שנאמר. אם יש שירה, כתוב רק שמדובר בשיר ובמה הוא עוסק. " + SPOKEN
      : "סכם בעברית את הסרטון: במה הוא עוסק, מי מדבר אם זה ידוע, והנקודות העיקריות לפי הסדר. " + SPOKEN;
    let last = "";
    for (const m of ["gemini-flash-latest", "gemini-flash-lite-latest"]) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ file_data: { file_uri: "https://www.youtube.com/watch?v=" + job.id } }, { text: prompt }] }], generationConfig: { mediaResolution: "MEDIA_RESOLUTION_LOW", maxOutputTokens: job.mode === "full" ? 8000 : 1500, temperature: 0.2 } }),
          signal: AbortSignal.timeout(240000),
        });
        const j = await r.json();
        const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (t) { await env.KV.put(ck, t, { expirationTtl: 30 * 86400 }); return { kind: "say", text: t }; }
        last = j?.error?.message || "empty";
      } catch (e) { last = e.message; }
    }
    await logEvent(env, "יוטיוב נכשל: " + last);
    return { kind: "say", text: "לא הצלחתי לעבד את הסרטון. ייתכן שהוא פרטי, מוגבל, או ארוך מדי." };
  }
  return { kind: "say", text: "סוג לא מוכר." };
}
async function startMediaJob(ctx, st, job) {
  const id = "mj" + st.n;
  st.media = { ...(st.media || {}), job: id, polls: 0 };
  await startBgJob(ctx, id, job);
  st.step = "mediaWait";
  return mediaWaitPrompt(st, job.type === "youtube" ? "מכין את הסרטון. זה יכול לקחת עד כמה דקות" : job.type === "recsave" ? "שומר ומתמלל, זה יכול לקחת קצת זמן" : "מכין את הקובץ לשמיעה, רגע");
}
function mediaWaitPrompt(st, text = "") {
  st.media.music = ((st.media.music || 0) % 3) + 1;
  const v = nextVal(st);
  return `read=${(text ? sp(text, "m") + "." : "") + `f-${HOLD_DIR}${st.media.music}`}=${v},no,1,1,1,No,yes,no,,,,Ok,none,`;
}

H.mediaPick = async (st, input, ctx) => {
  const list = st.media.list;
  if (input === undefined) {
    const titles = await ytTitles(ctx.env, list.filter((x) => x.kind === "youtube").map((x) => x.id));
    list.forEach((x) => { if (x.kind === "youtube") x.title = titles[x.id]?.title || ""; if (x.kind === "youtube") x.dur = ytDur(titles[x.id]?.dur || ""); });
    if (list.length === 1) return go(st, "mediaPick", "1", ctx);
    st.step = "mediaPick";
    const label = (x) => x.kind === "youtube" ? `סרטון יוטיוב${x.title ? " " + x.title : ""}${x.from ? " ששלח " + x.from : ""}` : `${x.video ? "סרטון" : "הקלטה"}${x.from ? " ששלח " + x.from : ""}`;
    const parts = await Promise.all(list.map(async (x, i) => `${await heb(ctx.env, label(x))}: הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => String(i + 1))].join("."));
  }
  if (input === "none") return go(st, "mediaPick", undefined, ctx);
  const x = list[+input - 1];
  if (!x) return mediaBack(st, ctx);
  st.media.cur = x;
  if (x.kind === "file") return startMediaJob(ctx, st, { type: "file", res: x.res, drive: x.drive, mime: x.mime, name: x.name });
  st.step = "mediaYtMode";
  const about = x.title ? `הסרטון ${await heb(ctx.env, x.title)}${x.dur ? `, באורך ${x.dur}` : ""}.` : "";
  return (about ? R.msg(about) : "") + R.menu(st, "את השמע המקורי של יוטיוב אי אפשר להשמיע, אבל אפשר לשמוע אותו במילים. " + ytModePrompt(st), ytModeKeys(st));
};
const canAskFile = (st) => !!(st.media?.cur?.msgName && st.media.back === "conv" && st.conv);
const ytModePrompt = (st) => "לתקציר הסרטון הקש 1. לתמלול מלא בעברית הקש 2. " + (canAskFile(st) ? "לבקש בשרשור שישלחו את הסרטון כקובץ, כדי לשמוע את הקול המקורי, הקש 3. " : "") + "לחזרה הקש 0.";
const ytModeKeys = (st) => (canAskFile(st) ? "0.1.2.3" : "0.1.2");
const ASK_FILE_TEXT = "אפשר לשלוח את הסרטון הזה כקובץ? אני בטלפון ולא יכול לפתוח יוטיוב. תודה!";
H.mediaYtMode = async (st, input, ctx) => {
  if (input === "none") return R.menu(st, ytModePrompt(st), ytModeKeys(st));
  if (input === "3" && canAskFile(st)) {
    st.step = "mediaAskFile";
    return R.msg(`תישלח תשובה בשרשור, עם ציטוט של ההודעה עם הקישור: ${ASK_FILE_TEXT}`) + R.menu(st, "לשליחה הקש 1. לביטול הקש 0.", "0.1");
  }
  if (input !== "1" && input !== "2") return mediaBack(st, ctx);
  return startMediaJob(ctx, st, { type: "youtube", id: st.media.cur.id, mode: input === "2" ? "full" : "summary" });
};
H.mediaAskFile = async (st, input, ctx) => {
  if (input !== "1") return mediaBack(st, ctx, "לא נשלח.");
  const x = st.media.cur, space = st.conv.items[st.conv.i].space;
  const q = x.thread ? "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" : "";
  const base = { text: ASK_FILE_TEXT, ...(x.thread ? { thread: { name: x.thread } } : {}) };
  try {
    await gapi(ctx.env, `${G.chat}${space}/messages${q}`, { body: { ...base, quotedMessageMetadata: { name: x.msgName, lastUpdateTime: x.ut } } });
  } catch (e) {
    // אם הציטוט נדחה, שולחים בלי ציטוט רשמי אבל עם הטקסט המקורי
    await gapi(ctx.env, `${G.chat}${space}/messages${q}`, { body: { ...base, text: `"${trimText(x.text, 120)}"\n${ASK_FILE_TEXT}` } });
  }
  await logEvent(ctx.env, "נשלחה בקשה בשרשור לשלוח סרטון יוטיוב כקובץ");
  return mediaBack(st, ctx, "הבקשה נשלחה. כשישלחו את הקובץ, תוכל לשמוע אותו בשיחה בהקשה על 5.");
};
H.mediaWait = async (st, input, ctx) => {
  const job = await getJob(ctx.env, ctx.q.ApiCallId || "nocall");
  if (!job || job.id !== st.media.job || job.status !== "done") {
    st.media.polls++;
    if (st.media.polls > 70) return mediaBack(st, ctx, "זה לוקח יותר מדי זמן. נסה שוב מאוחר יותר.");
    return mediaWaitPrompt(st);
  }
  if (job.kind === "play") {
    st.media.file = job.file;
    return go(st, "mediaPlay", undefined, ctx);
  }
  const pages = [];
  let t = String(job.text || "");
  while (t.length) { const cut = t.length <= 2500 ? t.length : Math.max(t.lastIndexOf(". ", 2500) + 1, 1500); pages.push(t.slice(0, cut)); t = t.slice(cut).trim(); }
  st.media.pages = pages; st.media.page = 0;
  return go(st, "mediaText", undefined, ctx);
};
H.mediaPlay = async (st, input, ctx) => {
  if (input === undefined || input === "1") {
    st.step = "mediaPlay";
    const v = nextVal(st);
    return `read=f-${st.media.file}.${sp("לשמיעה חוזרת הקש 1. לחזרה הקש 0.", "m")}=${v},no,1,1,10,No,yes,no,,0.1,,Ok,none,`;
  }
  return mediaBack(st, ctx);
};
H.mediaText = async (st, input, ctx) => {
  const m = st.media;
  if (input === "1") m.page++;
  else if (input === "2") m.page = 0;
  else if (input !== undefined) return mediaBack(st, ctx);
  if (m.page >= m.pages.length) return mediaBack(st, ctx, "זה הסוף.");
  st.step = "mediaText";
  const more = m.page < m.pages.length - 1;
  return R.msg(m.pages[m.page]) + R.menu(st, (more ? "להמשך הקש 1. " : "") + "לשמיעה מההתחלה הקש 2. לחזרה הקש 0.", more ? "0.1.2" : "0.2");
};
function mediaBack(st, ctx, pre = "") {
  const back = st.media?.back;
  delete st.media;
  if (back === "conv" && st.conv) { st.step = "convMenu"; return (pre ? R.msg(pre) : "") + convMenuRead(st, st.conv.items[st.conv.i]); }
  if (back === "ai" && st.ai) return go(st, "aiListen", undefined, ctx, pre);
  if (back === "mail" && st.cur) { st.step = "mailMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  if (back === "files") return go(st, "filesMenu", undefined, ctx, pre);
  return go(st, "main", undefined, ctx, pre);
}

// ================================================================ שיחה עם קלאוד (מקש 7)
// ההודעות נשמרות בתור. ריצה מתוזמנת של Claude בודקת כל שעה; כשהיא רצה היא "מחוברת", ואז אפשר לנהל שיחה חיה.
H.claudeStart = async (st, input, ctx) => {
  const b = await bridge(ctx.env, "state");
  st.cl = { list: b.unheard, i: 0, polls: 0 };
  if (b.unheard.length) {
    const n = b.unheard.length;
    return go(st, "clAnswer", undefined, ctx, n === 1 ? "יש לך תשובה חדשה מקלאוד." : `יש לך ${n} תשובות חדשות מקלאוד.`);
  }
  return go(st, "clIntro", undefined, ctx);
};
const CL_CONFIRM = "לאישור הקש 1. לביטול הקש 2. לבקשת שינוי הקש 3.";
H.clAnswer = async (st, input, ctx) => {
  const c = st.cl;
  if (c.i >= c.list.length) return go(st, "clIntro", undefined, ctx);
  const a = c.list[c.i];
  await bridge(ctx.env, "heard", { ids: [a.id] });
  if (a.confirm) {
    st.step = "clConfirm";
    return R.msg(a.text) + R.menu(st, CL_CONFIRM, "1.2.3");
  }
  c.i++;
  return R.msg(a.text) + (await go(st, "clAnswer", undefined, ctx));
};
H.clConfirm = async (st, input, ctx) => {
  const c = st.cl, a = c.list[c.i];
  if (input === "1" || input === "2") {
    await bridge(ctx.env, "add", { kind: "approval", text: `(${input === "1" ? "מאושר" : "לא מאושר, לבטל"}) לגבי הבקשה לאישור: ${a.confirm}` });
    c.i++;
    return go(st, "clAnswer", undefined, ctx, input === "1" ? "אישרת. קלאוד יבצע את זה." : "ביטלת. זה לא יבוצע.");
  }
  if (input === "3") { st.step = "clChange"; return R.record(st, "אמור מה לשנות אחרי הצליל, ובסיום הקש סולמית."); }
  return R.menu(st, CL_CONFIRM, "1.2.3");
};
H.clChange = async (st, input, ctx) => {
  const c = st.cl, a = c.list[c.i];
  const t = await transcribeVal(ctx.env, input, "message");
  if (!t) return go(st, "clAnswer", undefined, ctx, "לא שמעתי. הבקשה נשארה ממתינה.");
  await bridge(ctx.env, "add", { kind: "approval", text: `(בקשת שינוי) לגבי הבקשה לאישור: ${a.confirm}. מה לשנות: ${t}` });
  c.i++;
  return go(st, "clAnswer", undefined, ctx, "הבקשה לשינוי נשלחה לקלאוד.");
};
function ilTimeOf(ms) {
  const d = new Date(ms);
  const t = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const days = Math.floor((Date.now() - ms) / 86400e3);
  return `${days === 0 ? "היום" : days === 1 ? "אתמול" : `לפני ${days} ימים`} בשעה ${t}`;
}
H.clIntro = async (st, input, ctx, pre = "") => {
  const b = await bridge(ctx.env, "state");
  st.cl.live = b.live;
  st.step = "clRec";
  const last = b.lastRun && !st.cl.saidRun ? ` הבדיקה האחרונה של קלאוד הייתה ${ilTimeOf(b.lastRun)}.${b.pending ? ` ${b.pending === 1 ? "הודעה אחת" : b.pending + " הודעות"} שלך עדיין מחכות לתשובה.` : ""}` : "";
  st.cl.saidRun = true;
  const p = b.live
    ? "קלאוד מחובר עכשיו. דבר אחרי הצליל, ובסיום הקש סולמית. ליציאה הקש סולמית בלי לומר כלום."
    : `קלאוד לא מחובר כרגע.${last} השאר הודעה אחרי הצליל, וקלאוד יענה בבדיקה הבאה. הבדיקות הן בימים ראשון עד חמישי, פעם בשעה, מאחת בצהריים עד ארבע, ומשבע בערב עד שתיים בלילה. אפשר גם לשלוח לקלאוד מייל מהמייל העסקי לעצמך, עם המילה שש בנושא. בסיום הקש סולמית. ליציאה הקש סולמית בלי לומר כלום.`;
  return (pre ? R.msg(pre) : "") + R.record(st, p);
};
H.clRec = async (st, input, ctx) => {
  const t = await transcribeVal(ctx.env, input, "message");
  if (t === null) { delete st.cl; return go(st, "main", undefined, ctx, "יצאת משיחה עם קלאוד."); }
  if (!t) return go(st, "clIntro", undefined, ctx, "לא שמעתי. נסה שוב.");
  const { id } = await bridge(ctx.env, "add", { text: (st.cl.prefix || "") + t });
  const b = await bridge(ctx.env, "state");
  if (!b.live) return go(st, "clIntro", undefined, ctx, "ההודעה נשמרה. תשמע את התשובה כשתתקשר שוב.");
  st.cl.wait = id;
  st.cl.polls = 0;
  st.step = "clWait";
  return clWaitPrompt(st, "ההודעה נשלחה. קלאוד עונה, רגע");
};
function clWaitPrompt(st, text = "") {
  st.cl.music = ((st.cl.music || 0) % 3) + 1;
  const v = nextVal(st);
  return `read=${(text ? sp(text, "m") + "." : "") + `f-${HOLD_DIR}${st.cl.music}`}=${v},no,1,1,1,No,yes,no,,,,Ok,none,`;
}
H.clWait = async (st, input, ctx) => {
  const c = st.cl;
  const r = await bridge(ctx.env, "answerFor", { re: c.wait });
  if (r.answer) {
    c.list = [r.answer]; c.i = 0;
    return go(st, "clAnswer", undefined, ctx);
  }
  c.polls++;
  if (!r.live && c.polls > 3) return go(st, "clIntro", undefined, ctx, "קלאוד התנתק בינתיים. התשובה תחכה לך כאן בפעם הבאה שתתקשר.");
  if (c.polls % 45 === 0) {
    st.step = "clWaitMore";
    return R.menu(st, "קלאוד עדיין עובד על התשובה. להמשך המתנה הקש 1. לחזרה לתפריט הראשי הקש 2, והתשובה תחכה לך.", "1.2");
  }
  return clWaitPrompt(st);
};
H.clWaitMore = async (st, input, ctx) => {
  if (input === "1") { st.step = "clWait"; st.cl.polls++; return clWaitPrompt(st, "ממשיכים לחכות"); }
  delete st.cl;
  return go(st, "main", undefined, ctx);
};

// ================================================================ קול טבעי, מונים, המשך מאיפה שעצרת
// קול טבעי: הטקסט נשלח ל-Gemini TTS (קול גברי), הקובץ מועלה לימות (/tts/<hash>.wav) ונשמר במטמון.
// אם משהו נכשל או שהקול כבוי בהגדרות, משתמשים ב-TTS הרגיל של ימות.

async function bump(env, kind) {
  try {
    const k = "usage:" + new Date().toISOString().slice(0, 10);
    const u = await kvJson(env, k, {});
    u[kind] = (u[kind] || 0) + 1;
    await env.KV.put(k, JSON.stringify(u), { expirationTtl: 40 * 86400 });
  } catch {}
}

const decSp = (b) => { try { return new TextDecoder().decode(unb64url(b)); } catch { return ""; } };
const SP_RE = /\u0001([cm])([A-Za-z0-9_-]*)\u0002/g;
function renderPlain(out) { return out.replace(SP_RE, (_, k, b) => say(decSp(b))); }
// מצב הקול: all = טבעי לכל דבר, content = טבעי לתוכן בלבד (ברירת מחדל), off = הקול הרגיל של ימות
async function voiceMode(env) {
  if (!env.GEMINI_KEY) return "off";
  const v = await env.KV.get("voice");
  return v === "off" || v === "all" ? v : "content";
}
const voiceOn = async (env) => (await voiceMode(env)) !== "off";
async function renderSpeech(env, out) {
  if (!out.includes(SP0)) return out;
  const mode = await voiceMode(env);
  if (mode === "off") return renderPlain(out);
  // תקציב זמן אחד לכל הקול הטבעי בתשובה: מה שלא מוכן בזמן מוקרא בקול של ימות (ימות לא מחכה לתשובה איטית)
  const deadline = Date.now() + (+env.VOICE_BUDGET_MS || 8000);
  const items = [...out.matchAll(SP_RE)].map((m) => ({ k: m[1], t: decSp(m[2]) }));
  const done = await Promise.all(items.map((x) => (mode === "all" || x.k === "c" ? voiceSay(env, x.t, deadline).catch(() => say(x.t)) : say(x.t))));
  let i = 0;
  return out.replace(SP_RE, () => done[i++]);
}
// ניקוי לקול טבעי: שומר פיסוק, מסיר קישורים, אימוג'י וסימני עיצוב
function cleanForVoice(t) {
  return cleanForSpeech(t)
    .replace(/[*_#>`~|]+/g, " ")
    .replace(/\s*\n\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s+/g, " ").trim();
}
function chunkText(t, n) {
  const out = [];
  while (t.length) {
    if (t.length <= n) { out.push(t); break; }
    let cut = Math.max(t.lastIndexOf(". ", n), t.lastIndexOf("? ", n), t.lastIndexOf("! ", n));
    if (cut < n * 0.4) cut = Math.max(t.lastIndexOf(", ", n), t.lastIndexOf(" ", n));
    if (cut < n * 0.4) cut = n;
    out.push(t.slice(0, cut + 1).trim());
    t = t.slice(cut + 1).trim();
  }
  return out.filter(Boolean);
}
async function voiceSay(env, t, deadline = Date.now() + 30000) {
  const clean = cleanForVoice(t);
  if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return say(t);
  const chunks = chunkText(clean, 1200);
  const files = await Promise.all(chunks.slice(0, 4).map((c) => ttsFile(env, c, deadline).catch((e) => { logEvent(env, "קול טבעי נכשל: " + trimText(e.message, 120)); return null; })));
  return chunks.map((c, i) => (files[i] ? "f-" + files[i] : say(c))).join(".");
}
function sentenceChunks(t) {
  const parts = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && (out[out.length - 1].length < 25 || p.length < 12)) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out.length ? out : [t];
}
function pcmToWav(pcm, rate = 24000) {
  const h = new ArrayBuffer(44), v = new DataView(h);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h)); out.set(pcm, 44);
  return out;
}
// המכסה החינמית של קול היא 3 בקשות בדקה לכל מודל, לכן מסובבים בין כמה מודלים ומדלגים על מודל חסום
let ttsRound = 0;
async function ttsBytes(env, text, deadline = Date.now() + 30000) {
  const all = (env.TTS_MODELS || "gemini-3.8-flash-tts,gemini-2.5-flash-preview-tts,gemini-3.1-flash-tts-preview,gemini-3.8-flash-lite-tts").split(",").map((s) => s.trim());
  const start = ttsRound++ % all.length;
  const models = all.slice(start).concat(all.slice(0, start)).filter((x) => !isBusy(x));
  let last = "";
  for (const m of models) {
    const left = deadline - Date.now();
    if (left < 1500) { last = last || "timeout"; break; }
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "קרא בעברית, בקול גברי רגוע וברור, בקצב טבעי של שיחה בטלפון. שמות באנגלית בטא כרגיל:\n" + text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.TTS_VOICE || "Orus" } } } },
        }),
        signal: AbortSignal.timeout(Math.min(14000, left)),
      });
      const j = await r.json();
      bump(env, "tts");
      const p = j?.candidates?.[0]?.content?.parts?.find((x) => x.inlineData);
      if (p) {
        const bytes = unb64url(p.inlineData.data.replace(/-/g, "+").replace(/_/g, "/"));
        const mime = p.inlineData.mimeType || "";
        if (/wav/.test(mime)) return bytes;
        const rate = +(mime.match(/rate=(\d+)/)?.[1] || 24000);
        return pcmToWav(bytes, rate);
      }
      markBusy(m, j);
      if (j?.error?.code === 429) bump(env, "quota");
      last = JSON.stringify(j).slice(0, 160);
    } catch (e) { last = e.message; if (e.name === "TimeoutError") geminiBusy.set(m, Date.now() + 60e3); }
  }
  throw new Error("tts: " + last);
}
async function ttsFile(env, text, deadline = Date.now() + 30000) {
  const key = (await sha("v1|" + (env.TTS_VOICE || "Orus") + "|" + text)).slice(0, 24);
  const file = "/tts/" + key;
  if (await env.KV.get("tts:" + key)) return file;
  const wav = await ttsBytes(env, text, deadline);
  if (deadline - Date.now() < 1000) throw new Error("timeout before upload");
  const fd = new FormData();
  fd.append("token", env.YM_TOKEN);
  fd.append("path", `ivr2:${file}.wav`);
  fd.append("convertAudio", "1");
  fd.append("file", new Blob([wav], { type: "audio/wav" }), "t.wav");
  const u = await (await fetch(YM + "UploadFile", { method: "POST", body: fd, signal: AbortSignal.timeout(Math.min(12000, Math.max(1000, deadline - Date.now()))) })).json();
  if (u.responseStatus !== "OK") throw new Error("upload: " + (u.message || u.responseStatus));
  await env.KV.put("tts:" + key, "1", { expirationTtl: 90 * 86400 });
  return file;
}

// ---- המשך מאיפה שעצרת: בניתוק באמצע קריאת מיילים או שיחות, שומרים איפה היינו
async function saveResume(env, st) {
  if (!st?.authed) return;
  let r = null;
  if (st.mail && st.mail.ids && st.mail.i < st.mail.ids.length && st.step !== "main") r = { kind: "mail", cat: st.mail.cat, ids: st.mail.ids.slice(st.mail.i), name: st.mail.name || "" };
  else if (st.conv && st.conv.items && st.conv.i < st.conv.items.length && !st.conv.items[0].recent) r = { kind: st.conv.kind, n: st.conv.items.length - st.conv.i };
  if (!r) { await env.KV.delete("resume").catch(() => {}); return; }
  await env.KV.put("resume", JSON.stringify({ ...r, t: Date.now() }), { expirationTtl: 3 * 3600 });
}
H.resumeAsk = async (st, input, ctx, pre = "") => {
  const r = st.resume;
  if (input === undefined) {
    st.step = "resumeAsk";
    const where = r.kind === "mail" ? `באמצע המיילים ${r.name || CAT_NAME[r.cat] || ""}, ונשארו ${r.ids.length}` : r.kind === "dm" ? `באמצע ההודעות הפרטיות` : `באמצע הקבוצות`;
    return (pre ? R.msg(pre) : "") + R.menu(st, `בשיחה הקודמת עצרת ${where}. להמשך מאיפה שעצרת הקש 1. לתפריט הראשי הקש 2.`, "1.2");
  }
  delete st.resume;
  await ctx.env.KV.delete("resume").catch(() => {});
  if (input !== "1") return go(st, "main", undefined, ctx);
  if (r.kind === "mail") { st.mail = { ids: r.ids, i: 0, cat: r.cat, name: r.name }; return go(st, "mailItem", undefined, ctx, "ממשיכים."); }
  return go(st, r.kind === "dm" ? "dmStart" : "grpStart", undefined, ctx);
};

// ---- התראות אבטחה במייל (מספר לא מורשה, קוד שגוי)
async function securityAlert(env, ctx, what) {
  const p = (async () => {
    try { await gmailSend(env, { to: env.BUSINESS_EMAIL, subject: "התראת אבטחה מהקו", body: `${what}\nזמן: ${nowIL()}\n\nאם זה לא אתה, כדאי להחליף את הקוד הסודי בקו (הגדרות, 9 ואז 1).` }); }
    catch (e) { await logEvent(env, "שליחת התראה נכשלה: " + e.message); }
  })();
  ctx?.ctx?.waitUntil?.(p);
}

// ================================================================ קבצים והקלטות (מקש 8)

H.filesMenu = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "filesMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, "לשיתוף קובץ עם מישהו הקש 1. להקלטה ושמירה בדרייב או תמלול למסמך הקש 2. לקבצים ששותפו איתך לאחרונה הקש 3. לתפריט הראשי הקש 0.", "0.1.2.3"); }
  if (input === "1") { st.share = { back: "files" }; return go(st, "shareSrc", undefined, ctx); }
  if (input === "2") { st.recd = { parts: [] }; return go(st, "recDoc", undefined, ctx); }
  if (input === "3") return go(st, "sharedWithMe", undefined, ctx);
  return go(st, "main", undefined, ctx);
};

// ---- שיתוף קובץ: מקור -> למי -> איך -> אישור
H.shareSrc = async (st, input, ctx) => {
  if (input === undefined) { st.step = "shareSrc"; return R.menu(st, "לקובץ מהדרייב הקש 1. לקובץ שצורף למייל הקש 2. לקובץ שנשלח בצאט הקש 3. להקלטה חדשה הקש 4. לחזרה הקש 0.", "0.1.2.3.4"); }
  if (input === "1") { st.step = "shareDriveRec"; return R.record(st, "אמור את שם הקובץ או מילה מתוכו, ובסיום הקש סולמית."); }
  if (input === "2") { st.step = "shareMailRec"; return R.record(st, "אמור איזה מייל לחפש, למשל: המייל מדוד עם החשבונית. בסיום הקש סולמית."); }
  if (input === "3") { st.share.fromChat = true; return go(st, "chatSearchRec", undefined, ctx); }
  if (input === "4") { st.step = "shareRec"; return R.record(st, "הקלט אחרי הצליל, ובסיום הקש סולמית."); }
  return go(st, "filesMenu", undefined, ctx);
};
H.shareDriveRec = async (st, input, ctx) => {
  const spoken = await transcribeVal(ctx.env, input, "command");
  if (!spoken) return go(st, "shareSrc", undefined, ctx, "לא שמעתי.");
  const files = await LOOKUP.search_drive.run(ctx.env, { text: spoken }).catch(() => []);
  if (!files.length) return go(st, "shareSrc", undefined, ctx, `לא מצאתי בדרייב קובץ עם ${spoken}.`);
  st.share.srcList = files.slice(0, 8).map((f) => ({ type: "drive", id: f.id, name: f.name, mime: f.mimeType }));
  return go(st, "sharePickSrc", undefined, ctx);
};
H.shareMailRec = async (st, input, ctx) => {
  const env = ctx.env;
  const spoken = await transcribeVal(env, input, "nav");
  if (!spoken) return go(st, "shareSrc", undefined, ctx, "לא שמעתי.");
  const ids = await gmailIds(env, (await buildMailQuery(env, spoken)) + " has:attachment", 6);
  if (!ids.length) return go(st, "shareSrc", undefined, ctx, "לא מצאתי מייל עם קובץ מצורף לפי החיפוש.");
  const list = [];
  for (const id of ids) {
    const m = await gapi(env, `${G.gmail}messages/${id}?format=full`).catch(() => null);
    if (!m) continue;
    const from = parseAddr(header(m, "From")).name;
    for (const a of attachmentsOf(m.payload).slice(0, 3)) list.push({ type: "gmail", mailId: id, attId: a.id, name: a.name, mime: a.mime, size: a.size, label: `${a.name} מהמייל של ${from}` });
  }
  if (!list.length) return go(st, "shareSrc", undefined, ctx, "לא מצאתי קבצים מצורפים.");
  st.share.srcList = list.slice(0, 8);
  return go(st, "sharePickSrc", undefined, ctx);
};
H.shareRec = async (st, input, ctx) => {
  if (!input || input === "none") return go(st, "shareSrc", undefined, ctx, "לא הוקלט כלום.");
  st.share.src = { type: "rec", path: input, name: `הקלטה ${nowIL().slice(0, 16).replace(/[: ]/g, "-")}.wav`, label: "ההקלטה שהקלטת עכשיו", mime: "audio/wav" };
  return go(st, "shareWho", undefined, ctx);
};
H.sharePickChat = async (st, input, ctx) => {
  const list = st.share.srcList;
  if (input === undefined) {
    st.step = "sharePickChat";
    const parts = await Promise.all(list.map(async (a, i) => `${await heb(ctx.env, a.name)}${a.from ? " ששלח " + a.from : ""} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join("."));
  }
  const a = list[+input - 1];
  if (!a) { st.step = "convMenu"; return convMenuRead(st, st.conv.items[st.conv.i]); }
  st.share.src = { type: "chat", res: a.res, drive: a.drive, name: a.name, mime: a.mime };
  return go(st, "shareWho", undefined, ctx);
};
H.sharePickSrc = async (st, input, ctx) => {
  const list = st.share.srcList;
  if (input === undefined) {
    if (list.length === 1) return go(st, "sharePickSrc", "1", ctx);
    st.step = "sharePickSrc";
    const parts = await Promise.all(list.map(async (a, i) => `${await heb(ctx.env, a.label || a.name)} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join("."));
  }
  const a = list[+input - 1];
  if (!a) return go(st, "shareSrc", undefined, ctx);
  st.share.src = a;
  return go(st, "shareWho", undefined, ctx);
};
H.shareWho = async (st, input, ctx) => {
  if (input === undefined) { st.step = "shareWho"; return R.msg(st.share.src.label ? `נבחרה ${st.share.src.label}.` : `נבחר הקובץ ${await heb(ctx.env, st.share.src.name)}.`) + R.record(st, "אמור למי לשלוח, ובסיום הקש סולמית."); }
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) return go(st, "shareWho", undefined, ctx, spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.");
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "shareWhoPick";
  return R.menu(st, st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.shareWhoPick = async (st, input, ctx) => {
  const c = st.cands?.[+input - 1];
  if (!c) return shareBack(st, ctx, "בוטל.");
  st.share.to = c;
  st.step = "shareHow";
  return R.menu(st, "איך לשלוח? כקובץ מצורף במייל הקש 1. כקישור בצאט הקש 2. כהרשאה בדרייב הקש 3. לביטול הקש 0.", "0.1.2.3");
};
H.shareHow = async (st, input, ctx) => {
  const how = { 1: "mail", 2: "chat", 3: "drive" }[input];
  if (!how) return shareBack(st, ctx, "בוטל.");
  st.share.how = how;
  st.step = "shareConfirm";
  const w = { mail: "כקובץ מצורף במייל", chat: "כקישור בצאט", drive: "כהרשאת צפייה בדרייב" }[how];
  return R.menu(st, `לשלוח את ${st.share.src.label || await heb(ctx.env, st.share.src.name)} אל ${st.share.to.n} ${w}? לאישור הקש 1. לביטול הקש 0.`, "0.1");
};
H.shareConfirm = async (st, input, ctx) => {
  if (input !== "1") return shareBack(st, ctx, "בוטל.");
  try {
    await doShare(ctx.env, st.share);
    await logEvent(ctx.env, `קובץ ${st.share.src.name} נשלח ל${st.share.to.n} (${st.share.how})`);
    return shareBack(st, ctx, "נשלח.");
  } catch (e) {
    await logEvent(ctx.env, "שיתוף נכשל: " + e.message);
    return shareBack(st, ctx, "השליחה נכשלה.");
  }
};
function shareBack(st, ctx, pre = "") {
  const back = st.share?.back;
  if (st.share?.src?.type === "rec") ymDelete(ctx.env, st.share.src.path);
  delete st.share; delete st.cands;
  if (back === "mail" && st.cur) { st.step = "mailMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, MAIL_MENU, MAIL_KEYS); }
  if (back === "conv" && st.conv) { st.step = "convMenu"; return (pre ? R.msg(pre) : "") + convMenuRead(st, st.conv.items[st.conv.i]); }
  return go(st, "filesMenu", undefined, ctx, pre);
}
const GOOGLE_EXPORT = { "application/vnd.google-apps.document": ["application/pdf", ".pdf"], "application/vnd.google-apps.spreadsheet": ["application/pdf", ".pdf"], "application/vnd.google-apps.presentation": ["application/pdf", ".pdf"] };
// הבאת תוכן הקובץ ממקורו (דרייב, מייל, צאט או הקלטה)
async function srcBytes(env, src) {
  if (src.type === "rec") return { bytes: await recordingBytes(env, src.path), name: src.name, mime: "audio/wav" };
  if (src.type === "gmail") return { bytes: await attachmentBytes(env, src.mailId, src.attId), name: src.name, mime: src.mime || "application/octet-stream" };
  if (src.type === "chat") {
    if (src.drive) return srcBytes(env, { type: "drive", id: src.drive, name: src.name, mime: src.mime });
    const r = await fetch(`${G.chat}media/${src.res.split("/").map(encodeURIComponent).join("/")}?alt=media`, { headers: { Authorization: "Bearer " + (await accessToken(env)) } });
    if (!r.ok) throw new Error("chat media " + r.status);
    return { bytes: new Uint8Array(await r.arrayBuffer()), name: src.name, mime: src.mime || "application/octet-stream" };
  }
  const f = await gapi(env, `${DRIVE}files/${src.id}?fields=name,mimeType,size`);
  const ex = GOOGLE_EXPORT[f.mimeType];
  const url = ex ? `${DRIVE}files/${src.id}/export?mimeType=${encodeURIComponent(ex[0])}` : `${DRIVE}files/${src.id}?alt=media`;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + (await accessToken(env)) } });
  if (!r.ok) throw new Error("drive download " + r.status);
  return { bytes: new Uint8Array(await r.arrayBuffer()), name: ex ? f.name + ex[1] : f.name, mime: ex ? ex[0] : f.mimeType };
}
// מוודא שהקובץ נמצא בדרייב (מעלה אם צריך) ומחזיר מזהה וקישור
async function ensureInDrive(env, src) {
  if (src.type === "drive" || (src.type === "chat" && src.drive)) {
    const id = src.type === "drive" ? src.id : src.drive;
    const f = await gapi(env, `${DRIVE}files/${id}?fields=id,name,webViewLink`);
    return f;
  }
  const b = await srcBytes(env, src);
  return driveUpload(env, { name: b.name, mime: b.mime, bytes: b.bytes, folder: await driveFolder(env, "קבצים מהקו") });
}
async function doShare(env, share) {
  const { src, to, how } = share;
  if (how === "mail") {
    const b = await srcBytes(env, src);
    if (b.bytes.length > 20e6) throw new Error("גדול מדי למייל");
    await gmailSend(env, { to: to.e, subject: b.name, body: `שלום ${to.n},\nמצורף הקובץ ${b.name}.\n`, att: b });
    return;
  }
  const f = await ensureInDrive(env, src);
  await gapi(env, `${DRIVE}files/${f.id}/permissions?sendNotificationEmail=${how === "drive"}`, { body: { role: "reader", type: "user", emailAddress: to.e } });
  if (how === "chat") {
    const space = await chatDMSpace(env, to.e);
    await chatSend(env, space, `${f.name}\n${f.webViewLink}`);
  }
}

// ---- הקלטה לדרייב או תמלול למסמך (אפשר בכמה חלקים)
H.recDoc = async (st, input, ctx, pre = "") => {
  const n = st.recd.parts.length;
  if (input === undefined) { st.step = "recDoc"; return (pre ? R.msg(pre) : "") + R.record(st, n ? `הקלט את חלק ${n + 1} אחרי הצליל, ובסיום הקש סולמית.` : "הקלט אחרי הצליל: הכתבה, שיעור או פגישה, עד שלוש דקות בכל חלק. בסיום הקש סולמית."); }
  if (!input || input === "none") return st.recd.parts.length ? go(st, "recDocMenu", undefined, ctx) : go(st, "filesMenu", undefined, ctx, "לא הוקלט כלום.");
  st.recd.parts.push(input);
  return go(st, "recDocMenu", undefined, ctx);
};
H.recDocMenu = async (st, input, ctx) => {
  const n = st.recd.parts.length;
  if (input === undefined) { st.step = "recDocMenu"; return R.menu(st, `${n === 1 ? "הוקלט חלק אחד" : `הוקלטו ${n} חלקים`}. לשמירה כקובץ קול בדרייב הקש 1. לתמלול למסמך גוגל הקש 2. לשניהם הקש 3. להקלטת חלק נוסף הקש 4. לביטול הקש 0.`, "0.1.2.3.4"); }
  if (input === "4") return go(st, "recDoc", undefined, ctx);
  const mode = { 1: "audio", 2: "doc", 3: "both" }[input];
  if (!mode) { st.recd.parts.forEach((p) => ymDelete(ctx.env, p)); delete st.recd; return go(st, "filesMenu", undefined, ctx, "בוטל."); }
  st.media = { back: "files" };
  return startMediaJob(ctx, st, { type: "recsave", parts: st.recd.parts, mode });
};
async function runRecSave(env, job) {
  const folder = await driveFolder(env, "הקלטות מהקו");
  const stamp = nowIL().slice(0, 16);
  const texts = [];
  let saved = 0;
  for (let i = 0; i < job.parts.length; i++) {
    const bytes = await recordingBytes(env, job.parts[i]);
    if (job.mode !== "doc") { await driveUpload(env, { name: `הקלטה ${stamp}${job.parts.length > 1 ? ` חלק ${i + 1}` : ""}.wav`, mime: "audio/wav", bytes, folder }); saved++; }
    if (job.mode !== "audio") texts.push(await transcribe(env, bytes, "document").catch(() => ""));
    ymDelete(env, job.parts[i]);
  }
  let docMsg = "";
  if (job.mode !== "audio") {
    const text = texts.filter(Boolean).join("\n\n");
    if (!text) docMsg = "התמלול יצא ריק.";
    else {
      let title = "";
      try { title = (await llm(env, "תן כותרת של עד 5 מילים לטקסט הבא. החזר רק את הכותרת.", trimText(text, 800), 30)).split("\n")[0].trim(); } catch {}
      await driveUpload(env, { name: (title || "תמלול") + " " + stamp, mime: "text/plain", bytes: new TextEncoder().encode(text), folder, convertTo: "application/vnd.google-apps.document" });
      docMsg = `התמלול נשמר כמסמך בשם ${title || "תמלול"}. תחילת התמלול: ${trimText(text, 300)}`;
    }
  }
  await logEvent(env, `הקלטה נשמרה בדרייב (${job.mode}), ${job.parts.length} חלקים`);
  return { kind: "say", text: `${saved ? (saved === 1 ? "קובץ הקול נשמר בדרייב בתיקייה הקלטות מהקו. " : `${saved} קבצי קול נשמרו בדרייב. `) : ""}${docMsg}` };
}

// ---- קבצים ששותפו איתי לאחרונה
H.sharedWithMe = async (st, input, ctx) => {
  const env = ctx.env;
  if (input === undefined) {
    const j = await gapi(env, `${DRIVE}files?q=${encodeURIComponent("sharedWithMe=true and trashed=false")}&orderBy=sharedWithMeTime desc&pageSize=8&fields=files(id,name,mimeType,sharingUser(displayName),sharedWithMeTime)`);
    const files = j.files || [];
    if (!files.length) return go(st, "filesMenu", undefined, ctx, "לא שותפו איתך קבצים.");
    st.shared = files.map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, by: f.sharingUser?.displayName || "", at: f.sharedWithMeTime || "" }));
    st.step = "sharedWithMe";
    const parts = await Promise.all(st.shared.map(async (f, i) => `${await heb(env, f.name)}${f.by ? " מאת " + (await heb(env, f.by)) : ""}${f.at ? " " + relDate(f.at) : ""} הקש ${i + 1}`));
    return R.menu(st, parts.join(". ") + ". לחזרה הקש 0.", ["0", ...st.shared.map((_, i) => i + 1)].join("."));
  }
  const f = st.shared?.[+input - 1];
  if (!f) return go(st, "filesMenu", undefined, ctx);
  st.sharedCur = f; st.step = "sharedMenu";
  return R.menu(st, `${await heb(env, f.name)}. להקראה או סיכום הקש 1. לשליחה לאדם אחר הקש 2. לחזרה הקש 0.`, "0.1.2");
};
H.sharedMenu = async (st, input, ctx) => {
  const f = st.sharedCur;
  if (input === "1") {
    const t = await ACTIONS.read_drive_file.run(ctx.env, { id: f.id }).catch(() => "לא הצלחתי לקרוא את הקובץ.");
    st.media = { back: "files", pages: chunkText(t, 2000), page: 0 };
    return go(st, "mediaText", undefined, ctx);
  }
  if (input === "2") { st.share = { src: { type: "drive", id: f.id, name: f.name, mime: f.mime }, back: "files" }; return go(st, "shareWho", undefined, ctx); }
  return go(st, "sharedWithMe", undefined, ctx);
};

// ================================================================ הגדרות ומערכות (מקש 9)

const SETTINGS_PROMPT = "לקוד הסודי ולאבטחה הקש 1. לבחירת הקול, טבעי או רגיל, הקש 2. לרשימת האנשים החשובים הקש 3. לתשובות המוכנות הקש 4. לביטול השתקה של קבוצות הקש 5. לדוח השימוש בבינה מלאכותית הקש 6. למצב האתרים שלך הקש 7. לבוט מם כף הקש 8. לבקשת שינוי באתר דרך קלאוד הקש 9. לתפריט הראשי הקש 0.";
H.settingsMenu = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "settingsMenu"; return (pre ? R.msg(pre) : "") + R.menu(st, SETTINGS_PROMPT, "0.1.2.3.4.5.6.7.8.9"); }
  const to = { 1: "securityMenu", 2: "voicePick", 3: "vipMenu", 4: "cannedMenu", 5: "unmute", 6: "usageReport", 7: "sitesStatus", 8: "botMenu", 9: "siteChange" }[input];
  return go(st, to || "main", undefined, ctx);
};
H.securityMenu = async (st, input, ctx) => {
  if (input === undefined) { st.step = "securityMenu"; return R.menu(st, "להחלפת הקוד הסודי הקש 1. לניתוק חירום של החיבור לחשבון גוגל הקש 2. לחזרה הקש 0.", "0.1.2"); }
  if (input === "1") return go(st, "pinNew", undefined, ctx);
  if (input === "2") { st.step = "emergencyPin"; return R.digits(st, "ניתוק חירום מנתק את הקו מחשבון הגוגל, וכדי לחבר מחדש תצטרך להיכנס לדף החיבור במחשב. הקש את הקוד הסודי ובסיום סולמית", 4, 8); }
  return go(st, "settingsMenu", undefined, ctx);
};
H.emergencyPin = async (st, input, ctx) => {
  if (!input || input === "none" || (await sha(input)) !== (await currentPinHash(ctx.env))) return go(st, "settingsMenu", undefined, ctx, "הקוד שגוי. לא נותק.");
  st.step = "emergencyConfirm";
  return R.menu(st, "לאישור סופי של הניתוק הקש 1. לביטול הקש 0.", "0.1");
};
H.emergencyConfirm = async (st, input, ctx) => {
  const env = ctx.env;
  if (input !== "1") return go(st, "settingsMenu", undefined, ctx, "בוטל.");
  const refresh = await env.KV.get("g:refresh");
  if (refresh) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(refresh), { method: "POST" }).catch(() => {});
  await Promise.all(["g:refresh", "g:access", "g:email", "g:me", "contacts", "namehints", "resume"].map((k) => env.KV.delete(k).catch(() => {})));
  await logEvent(env, "ניתוק חירום: החיבור לגוגל בוטל מהטלפון");
  return R.msg("החיבור לחשבון גוגל נותק. להתראות.") + R.hangup();
};
H.voicePick = async (st, input, ctx) => {
  if (input === undefined) {
    const mode = await voiceMode(ctx.env);
    st.step = "voicePick";
    const cur = { all: "טבעי לכל דבר", content: "טבעי לתוכן ורגיל לתפריטים", off: "רגיל" }[mode];
    return R.menu(st, `הקול עכשיו ${cur}. לקול טבעי לתוכן ההודעות ולקול רגיל ומהיר לתפריטים, הקש 1. לקול טבעי לכל דבר, כולל תפריטים, שזה איטי יותר, הקש 2. לקול הרגיל של ימות בלבד הקש 3. לחזרה הקש 0.`, "0.1.2.3");
  }
  const m = { 1: "content", 2: "all", 3: "off" }[input];
  if (m) await ctx.env.KV.put("voice", m);
  return go(st, "settingsMenu", undefined, ctx, m ? "הקול שונה." : "");
};
// אנשים חשובים
H.vipMenu = async (st, input, ctx) => {
  const env = ctx.env;
  if (input === undefined) {
    const vip = await vipList(env);
    st.step = "vipMenu";
    const list = vip.length ? "ברשימה: " + vip.map((v) => v.n).join(", ") + ". " : "הרשימה ריקה. ";
    return R.menu(st, list + "להוספת אדם בדיבור הקש 1. להסרה הקש 2. לחזרה הקש 0.", "0.1.2");
  }
  if (input === "1") { st.step = "vipAddName"; return R.record(st, "אמור את שם האדם, ובסיום הקש סולמית."); }
  if (input === "2") {
    const vip = await vipList(env);
    if (!vip.length) return go(st, "vipMenu", undefined, ctx);
    st.step = "vipRemove";
    return R.menu(st, vip.slice(0, 9).map((v, i) => `להסרת ${v.n} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...vip.slice(0, 9).map((_, i) => i + 1)].join("."));
  }
  return go(st, "settingsMenu", undefined, ctx);
};
H.vipAddName = async (st, input, ctx) => {
  const spoken = await transcribeVal(ctx.env, input, "name");
  const found = spoken ? await findPeople(ctx.env, spoken) : [];
  if (!found.length) return go(st, "vipMenu", undefined, ctx, spoken ? `לא מצאתי איש קשר בשם ${spoken}.` : "לא שמעתי.");
  st.cands = found.map((f) => ({ n: f.n, e: f.e }));
  st.step = "vipAddPick";
  return R.menu(st, st.cands.map((c, i) => `${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לביטול הקש 0.", ["0", ...st.cands.map((_, i) => i + 1)].join("."));
};
H.vipAddPick = async (st, input, ctx) => {
  const c = st.cands?.[+input - 1];
  if (!c) return go(st, "vipMenu", undefined, ctx);
  const vip = await vipList(ctx.env);
  if (!vip.some((v) => v.e.toLowerCase() === c.e.toLowerCase())) vip.push(c);
  await ctx.env.KV.put("vip", JSON.stringify(vip.slice(-40)));
  return go(st, "vipMenu", undefined, ctx, `${c.n} נוסף.`);
};
H.vipRemove = async (st, input, ctx) => {
  const vip = await vipList(ctx.env), v = vip[+input - 1];
  if (!v) return go(st, "vipMenu", undefined, ctx);
  await ctx.env.KV.put("vip", JSON.stringify(vip.filter((x) => x !== v)));
  return go(st, "vipMenu", undefined, ctx, `${v.n} הוסר.`);
};
// תשובות מוכנות
H.cannedMenu = async (st, input, ctx) => {
  const env = ctx.env;
  const list = await cannedList(env);
  if (input === undefined) { st.step = "cannedMenu"; return R.menu(st, "התשובות המוכנות: " + list.map((t, i) => `${i + 1}, ${t}`).join(". ") + ". להוספת תשובה בדיבור הקש 1. למחיקת תשובה הקש 2. לחזרה הקש 0.", "0.1.2"); }
  if (input === "1") { st.step = "cannedAdd"; return R.record(st, "אמור את התשובה המוכנה, ובסיום הקש סולמית."); }
  if (input === "2") { st.step = "cannedDel"; return R.menu(st, list.map((t, i) => `למחיקת ${t} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...list.map((_, i) => i + 1)].join(".")); }
  return go(st, "settingsMenu", undefined, ctx);
};
H.cannedAdd = async (st, input, ctx) => {
  const t = await transcribeVal(ctx.env, input, "message");
  if (!t) return go(st, "cannedMenu", undefined, ctx, "לא שמעתי.");
  const list = await cannedList(ctx.env);
  await ctx.env.KV.put("canned", JSON.stringify([...list, t].slice(-9)));
  return go(st, "cannedMenu", undefined, ctx, "נוסף.");
};
H.cannedDel = async (st, input, ctx) => {
  const list = await cannedList(ctx.env), t = list[+input - 1];
  if (!t) return go(st, "cannedMenu", undefined, ctx);
  await ctx.env.KV.put("canned", JSON.stringify(list.filter((x) => x !== t)));
  return go(st, "cannedMenu", undefined, ctx, "נמחק.");
};
// ביטול השתקה
H.unmute = async (st, input, ctx) => {
  const env = ctx.env;
  const mute = await kvJson(env, "mute", []);
  if (input === undefined) {
    if (!mute.length) return go(st, "settingsMenu", undefined, ctx, "אין קבוצות מושתקות.");
    const names = await Promise.all(mute.slice(0, 9).map((s) => chatTitle(env, s)));
    st.muteNames = names;
    st.step = "unmute";
    return R.menu(st, names.map((n, i) => `לביטול ההשתקה של ${n} הקש ${i + 1}`).join(". ") + ". לחזרה הקש 0.", ["0", ...names.map((_, i) => i + 1)].join("."));
  }
  const s = mute[+input - 1];
  if (!s) return go(st, "settingsMenu", undefined, ctx);
  await env.KV.put("mute", JSON.stringify(mute.filter((x) => x !== s)));
  return go(st, "settingsMenu", undefined, ctx, "ההשתקה בוטלה.");
};
// דוח שימוש
H.usageReport = async (st, input, ctx) => {
  const env = ctx.env;
  const days = [];
  for (let i = 0; i < 7; i++) days.push(new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10));
  const all = await Promise.all(days.map((d) => kvJson(env, "usage:" + d, {})));
  const sum = (arr, k) => arr.reduce((a, u) => a + (u[k] || 0), 0);
  const line = (u, label) => `${label}: ${u.stt || 0} תמלולים, ${u.gemini || 0} פניות לג׳מיני, ${u.tts || 0} קטעי קול טבעי, ${u.cf || 0} פניות לקלאודפלר${u.quota ? `, ו ${u.quota} פעמים שמודל היה חסום במכסה` : ""}.`;
  const week = { stt: sum(all, "stt"), gemini: sum(all, "gemini"), tts: sum(all, "tts"), cf: sum(all, "cf"), quota: sum(all, "quota") };
  const text = `${line(all[0], "היום")} ${line(week, "בשבוע האחרון")} הכל במכסה החינמית. כשמודל חסום, הקו עובר אוטומטית למודל אחר או לקול הרגיל.`;
  return go(st, "settingsMenu", undefined, ctx, text);
};
// מצב האתרים
const SITES_DEFAULT = [
  { n: "ראש בראש", u: "https://shmuel-lamed.github.io/rosh-berosh-2/" },
  { n: "כלי מוזיקה", u: "https://shmuel-lamed.github.io/SongToNotes/" },
  { n: "גלריית שמחות", u: "https://shmuel-lamed.github.io/1/" },
  { n: "השרת של הגלריה", u: "https://simchas-gallery-api.smwlyqswkwt232.workers.dev/" },
];
async function sitesCheck(env) {
  const sites = (await kvJson(env, "sites")) || SITES_DEFAULT;
  return Promise.all(sites.map(async (s) => {
    const t = Date.now();
    try {
      const r = await fetch(s.u, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "yemot-line-check" } });
      const sec = (Date.now() - t) / 1000;
      return `${s.n}: ${r.ok ? "תקין" : "מחזיר שגיאה " + r.status}, זמן תגובה ${sec < 1 ? "פחות משנייה" : Math.round(sec) + " שניות"}`;
    } catch (e) { return `${s.n}: לא מגיב`; }
  }));
}
H.sitesStatus = async (st, input, ctx) => go(st, "settingsMenu", undefined, ctx, (await sitesCheck(ctx.env)).join(". ") + ".");

// ---- בוט מ.כ: שיחה עם הבוט דרך השיחה הפרטית שלו בצאט (לא נוגעים בבוט עצמו)
async function botSpace(env) {
  const c = await env.KV.get("mc:space");
  if (c) return c;
  const me = await myUserId(env);
  for (const s of (await chatSpaces(env)).filter(isDM).slice(0, 40)) {
    try {
      const j = await gapi(env, `${G.chat}${s.name}/members?pageSize=10`);
      const bot = (j.memberships || []).find((m) => m.member?.type === "BOT" || /מ\.?כ|חימקה|בוט/.test(m.member?.displayName || ""));
      if (bot && !/^users\/\d+$/.test(bot.member?.name || "") || (bot && bot.member?.type === "BOT")) { await env.KV.put("mc:space", s.name); return s.name; }
    } catch {}
  }
  return "";
}
H.botMenu = async (st, input, ctx) => {
  const env = ctx.env;
  if (input === undefined) {
    const space = await botSpace(env);
    if (!space) return go(st, "settingsMenu", undefined, ctx, "לא מצאתי שיחה פרטית עם הבוט בצאט. שלח לו הודעה פעם אחת מהמחשב, ואז זה יעבוד.");
    const me = await myUserId(env);
    const msgs = (await spaceMessages(env, space, null, 4)).map((m) => `${m.sender?.name === "users/" + me ? "אתה" : "הבוט"}: ${trimText(msgText(m), 300)}`).join(". ");
    st.step = "botMenu";
    return R.msg(msgs ? "ההודעות האחרונות עם הבוט: " + msgs : "אין הודעות.") + R.menu(st, "לשליחת פקודה לבוט בדיבור, למשל מצב, עצור, הפעל, או אשר את הפוסט, הקש 1. לחזרה הקש 0.", "0.1");
  }
  if (input === "1") { st.step = "botRec"; return R.record(st, "אמור את הפקודה לבוט, ובסיום הקש סולמית."); }
  return go(st, "settingsMenu", undefined, ctx);
};
H.botRec = async (st, input, ctx) => {
  const env = ctx.env;
  const t = await transcribeVal(env, input, "command");
  if (!t) return go(st, "botMenu", undefined, ctx, "לא שמעתי.");
  st.bot = { text: t };
  st.step = "botConfirm";
  return R.menu(st, `לשלוח לבוט: ${t}? לאישור הקש 1. לביטול הקש 0.`, "0.1");
};
H.botConfirm = async (st, input, ctx) => {
  const env = ctx.env;
  if (input !== "1") return go(st, "botMenu", undefined, ctx, "בוטל.");
  const space = await botSpace(env);
  await chatSend(env, space, st.bot.text);
  await logEvent(env, "נשלחה פקודה לבוט מ.כ: " + st.bot.text);
  st.bot.sentAt = new Date().toISOString(); st.bot.polls = 0;
  st.step = "botWait"; st.media = { ...(st.media || {}), music: 0 };
  return mediaWaitPrompt(st, "נשלח. מחכה לתשובה מהבוט");
};
H.botWait = async (st, input, ctx) => {
  const env = ctx.env;
  const space = await botSpace(env);
  const me = await myUserId(env);
  const reply = (await spaceMessages(env, space, st.bot.sentAt, 5).catch(() => [])).filter((m) => m.sender?.name !== "users/" + me);
  if (reply.length) { delete st.media; return go(st, "botMenu", undefined, ctx, "הבוט ענה: " + reply.map(msgText).join(". ")); }
  st.bot.polls++;
  if (st.bot.polls > 12) { delete st.media; return go(st, "botMenu", undefined, ctx, "הבוט עדיין לא ענה. תוכל לבדוק שוב בתפריט הזה."); }
  return mediaWaitPrompt(st);
};
// בקשת שינוי באתר: נשלחת לקלאוד דרך הגשר, עם אישור בקו לפני העלאה
H.siteChange = async (st, input, ctx) => {
  st.cl = { list: [], i: 0, polls: 0, prefix: "(בקשה לשינוי באתר, מהטלפון) " };
  return go(st, "clIntro", undefined, ctx, "תאר מה לשנות ובאיזה אתר. קלאוד יכין את השינוי ויבקש ממך אישור בקו לפני שהוא עולה לאוויר.");
};

// ================================================================ ניווט בדיבור (מקש 0 בתפריט הראשי)
const NAV_TARGETS = "mail_primary, mail_updates, mail_vip, mail_todo, mail_search, mail_unanswered, dm, groups, chat_search, new_email, new_chat, summary, assistant, claude, files, share_file, record_to_drive, settings, phone_lookup, sites_status, bot, unknown";
H.navRec = async (st, input, ctx, pre = "") => {
  if (input === undefined) { st.step = "navRec"; return (pre ? R.msg(pre) : "") + R.record(st, "אמור לאן ללכת או מה לחפש, למשל: המיילים החדשים, הקבוצה של השיעור, מה הטלפון של דוד, או תשלח הודעה לאברהם. בסיום הקש סולמית."); }
  const env = ctx.env;
  const spoken = await transcribeVal(env, input, "nav");
  if (!spoken) return go(st, "main", undefined, ctx, "לא שמעתי.");
  let j = { target: "unknown" };
  try {
    const out = await llm(env, `המשתמש אמר בטלפון לאן הוא רוצה להגיע בקו. החזר JSON בלבד: target אחד מתוך: ${NAV_TARGETS}. query: הטקסט הרלוונטי לחיפוש (שם אדם, שם קבוצה, נושא), או ריק. הסברים: mail_search לחיפוש מייל מסוים, chat_search לפתיחת קבוצה או שיחה לפי שם, new_email או new_chat לשליחת הודעה לאדם (query = שם האדם), phone_lookup למספר טלפון של מישהו, assistant לבקשה מורכבת או שאלה כללית, claude לדיבור עם קלאוד.`, spoken, 120);
    j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {}
  const t = j.target, q = String(j.query || "").trim();
  const cat = { mail_primary: "1", mail_updates: "2", mail_vip: "3", mail_todo: "4" }[t];
  if (cat) { await H.mailStart(st, undefined, ctx); return H.mailStart(st, cat, ctx); }
  if (t === "mail_search") return q ? mailSearchRun(st, ctx, q) : go(st, "mailSearchRec", undefined, ctx);
  if (t === "mail_unanswered") return go(st, "unanswered", undefined, ctx);
  if (t === "dm") return go(st, "dmStart", undefined, ctx);
  if (t === "groups") return go(st, "grpStart", undefined, ctx);
  if (t === "chat_search") return q ? chatSearchRun(st, ctx, q) : go(st, "chatSearchRec", undefined, ctx);
  if (t === "new_email" || t === "new_chat") {
    st.newKind = t === "new_email" ? "email" : "chat"; st.tries = 0;
    if (!q) return go(st, "newName", undefined, ctx);
    const found = await findPeople(env, q);
    if (!found.length) return go(st, "newName", undefined, ctx, `לא מצאתי איש קשר בשם ${q}.`);
    st.cands = found.map((f) => ({ n: f.n, e: f.e })); st.step = "newPick";
    return R.menu(st, st.cands.map((c, i) => `עבור ${c.n}${dupName(st.cands, c) ? " בכתובת " + c.e.split("@")[0] : ""} הקש ${i + 1}`).join(". ") + ". לאמירת השם מחדש הקש 9. לביטול הקש 0.", ["0", "9", ...st.cands.map((_, i) => String(i + 1))].join("."));
  }
  if (t === "summary") return go(st, "summary", undefined, ctx);
  if (t === "assistant") { st.ai = { h: [] }; return aiAsk(st, ctx, spoken); }
  if (t === "claude") return go(st, "claudeStart", undefined, ctx);
  if (t === "files") return go(st, "filesMenu", undefined, ctx);
  if (t === "share_file") { st.share = { back: "files" }; return go(st, "shareSrc", undefined, ctx); }
  if (t === "record_to_drive") { st.recd = { parts: [] }; return go(st, "recDoc", undefined, ctx); }
  if (t === "settings") return go(st, "settingsMenu", undefined, ctx);
  if (t === "sites_status") return go(st, "sitesStatus", undefined, ctx);
  if (t === "bot") return go(st, "botMenu", undefined, ctx);
  if (t === "phone_lookup") return go(st, "main", undefined, ctx, await phoneLookup(env, q || spoken));
  st.ai = { h: [] };
  return aiAsk(st, ctx, spoken);
};
async function phoneLookup(env, name) {
  const res = await LOOKUP.get_contact_details.run(env, { name }).catch(() => []);
  const hit = res.filter((p) => p.phones?.length);
  if (!hit.length) return `לא מצאתי מספר טלפון עבור ${name}.`;
  return hit.slice(0, 3).map((p) => `${p.name}: ${p.phones.slice(0, 2).join(", ו ")}`).join(". ") + ".";
}
// הפעלת העוזר החכם עם טקסט מוכן (בלי הקלטה נוספת)
async function aiAsk(st, ctx, text) {
  const jobId = "j" + st.n;
  st.ai.job = jobId; st.ai.polls = 0;
  await startBgJob(ctx, jobId, { type: "ai", history: st.ai.h, text });
  st.step = "aiWait";
  return aiWaitPrompt(st, "רגע, אני בודק");
}

// ================================================================ קלאוד במייל, זיכרון העוזר, חיפוש באינטרנט, משימות מתוזמנות

// ---- מיילים לקלאוד: מייל שהוא שולח מהמייל העסקי לעצמו, עם "שש" בנושא
const CL_SUBJECT = "שש";
async function claudeMails(env) {
  const me = String(env.BUSINESS_EMAIL || "").toLowerCase();
  const done = new Set(await kvJson(env, "clmail:done", []));
  const ids = await gmailIds(env, `from:${me} to:${me} subject:${CL_SUBJECT} newer_than:14d`, 20);
  const out = [];
  for (const id of ids.filter((x) => !done.has(x))) {
    const m = await gmailGet(env, id).catch(() => null);
    if (!m || m.fromEmail.toLowerCase() !== me) continue;
    if (!/(^|\s)שש(\s|$|:)/.test(m.subject.replace(/^(re|fwd?)\s*:\s*/i, ""))) continue;
    out.push({ id, threadId: m.threadId, subject: m.subject, text: trimText(m.body, 6000), at: m.date, msgId: m.msgId, refs: m.refs });
  }
  return out;
}
async function markClaudeMailDone(env, ...ids) {
  const done = await kvJson(env, "clmail:done", []);
  await env.KV.put("clmail:done", JSON.stringify([...new Set([...done, ...ids])].slice(-300)));
}
async function claudeEmailReply(env, id, text) {
  const m = await gmailGet(env, id);
  const subject = /^re:/i.test(m.subject) ? m.subject : "Re: " + m.subject;
  const sent = await gmailSend(env, { to: env.BUSINESS_EMAIL, subject, body: text, threadId: m.threadId, inReplyTo: m.msgId, refs: m.refs });
  await markClaudeMailDone(env, id, sent.id);
  await logEvent(env, "קלאוד ענה במייל: " + trimText(text, 100));
  return sent;
}
// עותק במייל של תשובה שקלאוד נתן בקו
async function mailCopyOfAnswer(env, question, answer) {
  try { await gmailSend(env, { to: env.BUSINESS_EMAIL, subject: "תשובה מקלאוד בקו", body: `${question ? "השאלה שלך:\n" + question + "\n\n" : ""}התשובה:\n${answer}` }); }
  catch (e) { await logEvent(env, "עותק במייל נכשל: " + e.message); }
}

// ---- זיכרון של העוזר החכם בין שיחות (סיכום קצר של מה שחשוב)
async function updateAiMemory(env, history) {
  if (!history || history.length < 2) return;
  try {
    const old = (await env.KV.get("ai:mem")) || "";
    const conv = history.map((h) => (h.r === "user" ? "שמואל: " : "העוזר: ") + h.t).join("\n");
    const mem = await llm(env, "אתה מנהל זיכרון של עוזר אישי. לפניך הזיכרון הקיים והשיחה האחרונה. כתוב זיכרון מעודכן, עד 25 שורות קצרות, עם מה שכדאי לזכור לשיחות הבאות: העדפות של המשתמש, אנשים וקבוצות שהוא מזכיר הרבה, דברים שביקש לעקוב אחריהם, ומה נעשה לאחרונה (עם תאריך). בלי פרטים חד פעמיים חסרי חשיבות. החזר רק את הזיכרון.", `הזיכרון הקיים:\n${old || "(ריק)"}\n\nהשיחה האחרונה (${nowIL()}):\n${conv}`, 900);
    if (mem) await env.KV.put("ai:mem", trimText(mem, 3000));
  } catch (e) { await logEvent(env, "עדכון זיכרון נכשל: " + e.message); }
}

// ---- חיפוש באינטרנט (דרך Gemini עם Google Search)
Object.assign(LOOKUP, {
  web_search: {
    desc: "חיפוש באינטרנט (חדשות, מידע כללי, שעות פתיחה, מחירים, זמני כניסת שבת וכדומה). מחזיר תשובה מסוכמת מהרשת.",
    params: { query: ["STRING", "מה לחפש, בניסוח של שאלה"] }, req: ["query"],
    async run(env, a) {
      for (const m of ["gemini-flash-latest", "gemini-3.8-flash"].filter((x) => !isBusy(x))) {
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `חפש באינטרנט וענה בעברית, בקצרה ובמדויק, עם התאריך של המידע אם רלוונטי: ${a.query}` }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 700, temperature: 0.2 } }),
            signal: AbortSignal.timeout(15000),
          });
          const j = await r.json();
          bump(env, "gemini");
          const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
          if (t) return { answer: t };
          markBusy(m, j);
        } catch {}
      }
      return { error: "החיפוש באינטרנט לא זמין כרגע" };
    },
  },
});

// ---- סיכום יומי במייל (רץ מהמשימה המתוזמנת של Cloudflare בערב)
async function dailySummaryEmail(env) {
  const [prim, upd] = await Promise.all([gmailUnread(env, 15, "primary"), gmailUnread(env, 10, "updates")]);
  const mails = (await Promise.all([...prim.map((id) => [id, "ראשי"]), ...upd.map((id) => [id, "עדכונים"])].map(([id, cat]) => gmailGet(env, id).then((m) => ({ ...m, cat })).catch(() => null)))).filter(Boolean);
  let convs = [];
  try { convs = await chatUnread(env, "all"); } catch {}
  const todo = await gmailLabelId(env, TODO_LABEL).then((l) => gmailIds(env, `label:${TODO_LABEL}`, 20)).catch(() => []);
  const todoMeta = (await mailMeta(env, todo.slice(0, 10))).filter(Boolean);
  const tomorrow = await LOOKUP.list_events.run(env, { from: new Date(Date.now() + 86400e3).toISOString().slice(0, 10), to: new Date(Date.now() + 86400e3).toISOString().slice(0, 10) }).catch(() => []);
  const data = [
    ...mails.map((m) => `מייל (${m.cat}) מאת ${m.fromName}, נושא: ${m.subject}. ${trimText(m.body, 500)}`),
    ...convs.map((c) => (c.dm ? `צאט פרטי מ${c.title}: ` : `קבוצת ${c.title}: `) + trimText(c.msgs.map((m) => (c.dm ? m.t : m.n + ": " + m.t)).join(" | "), 600)),
  ].join("\n\n");
  const sum = data ? await llm(env, "סכם בעברית את המיילים והודעות הצאט שלא נקראו, עד 200 מילים, מסודר: קודם מה שדחוף או מבקשים ממני לעשות, אחר כך השאר בקצרה. ציין שמות. אל תמציא.", data, 800).catch(() => "") : "לא הגיעו מיילים או הודעות חדשים שלא נקראו.";
  const body = [
    `סיכום יומי מהקו, ${nowIL()}`, "",
    `מיילים שלא נקראו: ${prim.length} בראשי, ${upd.length} בעדכונים. שיחות צאט עם הודעות חדשות: ${convs.length}.`, "",
    sum, "",
    todoMeta.length ? "ברשימת לטיפול:\n" + todoMeta.map((m) => `- ${m.from.name}: ${m.subject}`).join("\n") : "רשימת לטיפול ריקה.", "",
    tomorrow.length ? "מחר ביומן:\n" + tomorrow.map((e) => `- ${String(e.start).slice(11, 16) || "כל היום"} ${e.title}`).join("\n") : "מחר אין אירועים ביומן.",
  ].join("\n");
  await gmailSend(env, { to: env.BUSINESS_EMAIL, subject: `סיכום יומי מהקו ${nowIL().slice(0, 10)}`, body });
  await logEvent(env, "נשלח סיכום יומי במייל");
}
// המשימה המתוזמנת של Cloudflare (כל 15 דקות)
async function scheduledTick(env) {
  await restoreSnoozed(env).catch((e) => logEvent(env, "שגיאת דחיות: " + e.message));
  const il = nowIL(); // "YYYY-MM-DD HH:MM, יום"
  const day = il.slice(0, 10), hm = il.slice(11, 16);
  if (hm >= "20:00" && hm < "20:20" && !isShabbatIL() && !(await env.KV.get("daily:" + day))) {
    await env.KV.put("daily:" + day, "1", { expirationTtl: 2 * 86400 });
    await dailySummaryEmail(env).catch((e) => logEvent(env, "סיכום יומי נכשל: " + e.message));
  }
}

// שלבים שבהם "none" הוא פול רגיל של המתנה למשימת רקע (מנגינת המתנה), ולא שתיקה של המתקשר
const WAIT_STEPS = new Set(["aiWait", "mediaWait", "clWait", "botWait"]);
// מעבר לשלב אחר (מריץ אותו מיד, בלי קלט)
const PRE_STEPS = new Set(["main", "grpBrowse", "rec", "aiListen", "clIntro", "mailStart", "mailSearchRec", "chatEmpty", "chatSearchRec", "filesMenu", "settingsMenu", "navRec", "recDoc", "resumeAsk"]);
async function go(st, step, input, ctx, pre = "") {
  st.step = step;
  if (!PRE_STEPS.has(step) && pre) {
    // הודעה מקדימה לפני שלב שאינו מקבל אותה ישירות
    const out = await H[step](st, input, ctx);
    return R.msg(pre) + out;
  }
  return H[step](st, input, ctx, pre);
}

// איחוד כמה הודעות להשמעה לפקודת id_list_message אחת (ימות מקבל אחת בלבד)
function mergeMessages(out) {
  const segs = out.split("&").filter(Boolean);
  const msgs = segs.filter((s) => s.startsWith("id_list_message=")).map((s) => s.slice("id_list_message=".length));
  const rest = segs.filter((s) => !s.startsWith("id_list_message="));
  return (msgs.length ? ["id_list_message=" + msgs.join(".")] : []).concat(rest).join("&");
}

async function handleYemot(req, env, ctx) {
  const url = new URL(req.url);
  const q = Object.fromEntries(url.searchParams);
  if (req.method === "POST") {
    try { const f = await req.formData(); for (const [k, v] of f) q[k] = String(v); } catch {}
  }
  const callId = q.ApiCallId || "nocall";
  if (q.hangup === "yes") {
    const old = await loadState(env, callId).catch(() => null);
    if (old) await saveResume(env, old).catch(() => {});
    await dropState(env, callId);
    return text("");
  }

  let st = (await loadState(env, callId)) || { step: "start", n: 0 };
  let input;
  if (st.expect) {
    input = q[st.expect];
    if (input === undefined) return text(st.last || R.hangup()); // בקשה חוזרת בלי קלט חדש
    if (input === "None" || input === "") input = "none";
    if (input === "*" && st.last) {
      // כוכבית: שמיעה חוזרת של מה שנאמר, עם שם משתנה חדש (ימות לא אוהבת read על משתנה שכבר קיבל ערך)
      const out = st.last.replace(/=V\d+,/, () => "=" + nextVal(st) + ",");
      st.last = out;
      await saveState(env, callId, st);
      return text(out);
    }
    if (input !== "none") st.idle = 0;
    // מתקשר ששותק לאורך זמן (לא בזמן המתנה למשימת רקע): מסיימים את השיחה במקום לחזור על התפריט בלי סוף
    if (input === "none" && !WAIT_STEPS.has(st.step)) {
      st.silent = (st.silent || 0) + 1;
      if (st.silent >= 6) {
        if (st.compose?.audio) ymDelete(env, st.compose.audio);
        await dropState(env, callId);
        return text(renderPlain(R.msg("לא התקבלה הקשה. להתראות") + R.hangup()));
      }
    } else if (input !== "none") st.silent = 0;
    // ימות עלולה לשלוח את אותה בקשה פעם נוספת כשהתשובה מתעכבת. מטפלים בכל הקשה פעם אחת בלבד:
    // הבקשה הכפולה מחכה שהראשונה תסיים ומחזירה את אותה תשובה (במקום לבצע את הפעולה פעמיים)
    if (!(await claimInput(env, callId, st.expect).catch(() => true))) {
      for (let i = 0; i < 36; i++) {
        await sleep(700);
        const b = await busyOf(env, callId).catch(() => null);
        if (!b || b.expect !== st.expect) break;
      }
      const fresh = await loadState(env, callId).catch(() => null);
      return text(fresh?.last || st.last || R.hangup());
    }
  }
  if (st.step !== "start" && st.step !== "pin" && !st.authed) st = { step: "start", n: st.n || 0 };

  let out;
  try {
    out = await H[st.step](st, input, { env, q, ctx });
  } catch (e) {
    await logEvent(env, `שגיאה בשלב ${st.step}: ${e.message}`);
    if (e instanceof NotConnected) out = R.msg("החיבור לחשבון הגוגל נותק. צריך לחבר אותו מחדש בדף החיבור. להתראות") + R.hangup();
    else if (st.authed) { try { out = await go(st, "main", undefined, { env, q, ctx }, "אירעה תקלה. חוזרים לתפריט הראשי."); } catch { out = R.msg("אירעה תקלה. להתראות") + R.hangup(); } }
    else out = R.msg("אירעה תקלה. להתראות") + R.hangup();
  }
  out = mergeMessages(out);
  try { out = await renderSpeech(env, out); } catch (e) { await logEvent(env, "שגיאת קול: " + e.message); out = renderPlain(out); }
  st.last = out;
  await saveState(env, callId, st);
  return text(out);
}

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
  if (url.searchParams.get("k") !== env.SETUP_KEY) return html(PAGE("לא מורשה", `<div class="card"><h1>אין גישה</h1></div>`), 403);
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
  if (url.searchParams.get("k") !== env.SETUP_KEY) return html(PAGE("לא מורשה", `<div class="card"><h1>אין גישה</h1></div>`), 403);
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
function isShabbatIL(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  const hm = (+p.hour % 24) * 60 + +p.minute;
  return (p.weekday === "Fri" && hm >= 15 * 60 + 30) || (p.weekday === "Sat" && hm < 20 * 60);
}
async function bridgeApi(req, env, url) {
  const key = url.searchParams.get("k") || req.headers.get("x-bridge-key");
  if (!env.BRIDGE_KEY || key !== env.BRIDGE_KEY) return new Response("forbidden", { status: 403 });
  const op = url.pathname.split("/")[2];
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const J = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json; charset=utf-8" } });
  if (op === "peek") {
    let new_emails = 0;
    try { new_emails = (await claudeMails(env)).length; } catch (e) { await logEvent(env, "בדיקת מיילים לקלאוד נכשלה: " + e.message); }
    return J({ ...(await bridge(env, "peek")), new_emails, shabbat: isShabbatIL(), now_israel: nowIL() });
  }
  if (op === "emails") return J({ emails: await claudeMails(env) });
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

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (env.PATH_KEY && path === "/yemot/" + env.PATH_KEY) return handleYemot(req, env, ctx);
    if (path.startsWith("/bridge/")) return bridgeApi(req, env, url);
    if (path === "/connect") return connect(env, url);
    if (path === "/oauth/callback") return oauthCallback(env, url);
    if (path === "/" || path === "/status") return statusPage(env, url);
    return new Response("not found", { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(scheduledTick(env)); },
};

// לבדיקות
export { saveMailToDrive, H, say, bodyOf, parseAddr, handleYemot, findPeople, toHebrew, transcribe, geminiTools, aiSystem, runMediaJob, scheduledTick, claudeMails, renderSpeech, chunkText };

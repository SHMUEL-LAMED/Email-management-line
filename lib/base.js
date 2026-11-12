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
// השוואה בזמן קבוע (מפתחות וקודים): משווים את ה-hash של שני הצדדים, כך שזמן התשובה לא מגלה כמה תווים נכונים
async function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b) return false;
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}
// הקוד הסודי נשמר ב-KV כחתימת HMAC עם מפתח סודי (PIN_SECRET, ואם אין – SETUP_KEY), עם הקידומת "v2:".
// hash ישן (SHA-256 בלי מפתח) עדיין מתקבל, ומומר לחתימה בכניסה המוצלחת הראשונה.
// הערה: החלפת SETUP_KEY (כשאין PIN_SECRET) מבטלת את הקוד השמור; במקרה כזה מוחקים את pin_hash ב-KV וחוזרים ל-PIN.
const pinSecret = (env) => env.PIN_SECRET || env.SETUP_KEY || "";
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(String(msg)));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function pinRecord(env, pin) {
  const key = pinSecret(env);
  return key ? "v2:" + (await hmacHex(key, pin)) : await sha(pin);
}
async function hasPin(env) {
  return !!(env.PIN || (await env.KV.get("pin_hash")));
}
async function checkPin(env, pin) {
  if (!pin) return false;
  pin = String(pin);
  const stored = await env.KV.get("pin_hash");
  if (stored && stored.startsWith("v2:")) return safeEq("v2:" + (await hmacHex(pinSecret(env), pin)), stored);
  if (stored) {
    const ok = await safeEq(await sha(pin), stored);
    if (ok && pinSecret(env)) await env.KV.put("pin_hash", await pinRecord(env, pin));
    return ok;
  }
  // אין קוד שמור ב-KV: הקוד הוא ה-Secret בשם PIN (שמור רק ב-Cloudflare)
  return !!env.PIN && safeEq(pin, String(env.PIN));
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

// אובייקט המצבים של השיחה: כל מודול מוסיף לו את השלבים שלו
const H = {};

export { YM, G, SCOPES, MAX_CHAT_SPACES, sleep, html, text, normPhone, b64, utf8b64, b64url, unb64url, decodeBody, sha, safeEq, pinSecret, hmacHex, pinRecord, hasPin, checkPin, randKey, esc, kvJson, logEvent, HEB_MONTHS, HEB_ABBR, cleanForSpeech, say, trimText, SP0, SP1, sp, R, nextVal, H };

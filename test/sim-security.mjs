// סימולציה: בדיקות אבטחה – השוואת מפתחות, שמירת הקוד הסודי, מפתח הגשר לפני קריאת התור, והורדת קבצים מהצאט
import worker, * as entry from "../entry.js";
import { safeEq, checkPin, pinRecord, healthCheck } from "../worker.js";

let fails = 0;
const ok = (cond, name) => { console.log((cond ? "ok - " : "FAIL - ") + name); if (!cond) fails++; };
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const mkKV = (init = []) => {
  const kv = new Map(init);
  return { kv, KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } } };
};

// השוואה בזמן קבוע
ok(await safeEq("abc", "abc"), "safeEq: מפתח זהה מתקבל");
ok(!(await safeEq("abd", "abc")), "safeEq: מפתח שונה נדחה");
ok(!(await safeEq("", undefined)), "safeEq: מפתח שלא הוגדר לא פותח גישה");
ok(!(await safeEq(null, "abc")), "safeEq: בלי מפתח בבקשה – נדחה");

// הקוד הסודי מה-Secret בלבד
{
  const { KV } = mkKV();
  const env = { KV, PIN: "1234", SETUP_KEY: "sk" };
  ok(await checkPin(env, "1234"), "קוד מה-PIN מתקבל");
  ok(!(await checkPin(env, "1235")), "קוד שגוי נדחה");
  ok(!(await checkPin(env, "")), "קוד ריק נדחה");
}
// hash ישן ב-KV: מתקבל ומומר לחתימה
{
  const { kv, KV } = mkKV([["pin_hash", await sha("5678")]]);
  const env = { KV, PIN: "1234", SETUP_KEY: "sk" };
  ok(!(await checkPin(env, "1234")), "כשיש קוד שמור ב-KV, ה-PIN הישן לא מתקבל");
  ok(await checkPin(env, "5678"), "hash ישן מתקבל");
  ok(kv.get("pin_hash").startsWith("v2:"), "hash ישן הומר לחתימת HMAC");
  ok(await checkPin(env, "5678"), "הקוד עובד גם אחרי ההמרה");
  ok(!(await checkPin(env, "5679")), "קוד שגוי נדחה אחרי ההמרה");
  ok(!(await checkPin({ ...env, SETUP_KEY: "other" }, "5678")), "חתימה עם מפתח אחר לא מתקבלת");
}
// החלפת קוד שומרת חתימה, לא hash פשוט
{
  const env = { SETUP_KEY: "sk", PIN_SECRET: "ps" };
  const rec = await pinRecord(env, "4321");
  ok(rec.startsWith("v2:") && rec !== "v2:" + (await sha("4321")), "קוד חדש נשמר כחתימה");
}

// מפתח הגשר נבדק לפני שקוראים מהתור
{
  const { KV } = mkKV();
  let doCalls = 0;
  const CALLS = { idFromName: (n) => n, get: () => ({ fetch: async () => { doCalls++; return new Response(JSON.stringify({ kind: "site" })); } }) };
  const env = { KV, CALLS, BRIDGE_KEY: "bk" };
  const r = await worker.fetch(new Request("https://x/bridge/answer", { method: "POST", body: JSON.stringify({ re: "m1", text: "x" }) }), env, { waitUntil() {} });
  ok(r.status === 403, "בלי מפתח – 403");
  ok(doCalls === 0, "בלי מפתח – התור לא נקרא");
  const r2 = await worker.fetch(new Request("https://x/bridge/state?k=wrong"), env, { waitUntil() {} });
  ok(r2.status === 403, "מפתח שגוי – 403");
}

// הורדת קובץ מהצאט: HTML יורד כקובץ, תמונה נפתחת
{
  const { KV } = mkKV([["g:access", "at"], ["g:refresh", "rt"]]);
  const env = { KV, PIN: "1234", BRIDGE_KEY: "bk" };
  let ctype = "text/html";
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }));
    if (url.includes("/media/")) return new Response("<script>x</script>", { headers: { "content-type": ctype } });
    throw new Error("unmocked " + url);
  };
  const login = await (await worker.fetch(new Request("https://x/chatsite/login", { method: "POST", body: JSON.stringify({ pin: "1234" }) }), env, {})).json();
  ok(!!login.token, "כניסה לאתר עם הקוד");
  const get = () => worker.fetch(new Request("https://x/chatsite/file?ref=abc&name=a.html", { headers: { "x-chat-token": login.token } }), env, {});
  let r = await get();
  ok(r.headers.get("content-disposition").startsWith("attachment"), "קובץ HTML יורד כקובץ");
  ok(r.headers.get("x-content-type-options") === "nosniff", "nosniff בהורדה");
  ctype = "image/png";
  r = await get();
  ok(r.headers.get("content-disposition").startsWith("inline"), "תמונה נפתחת בדפדפן");
  ctype = "image/svg+xml";
  r = await get();
  ok(r.headers.get("content-disposition").startsWith("attachment"), "SVG (שיכול להריץ קוד) יורד כקובץ");
  const bad = await (await worker.fetch(new Request("https://x/chatsite/login", { method: "POST", body: JSON.stringify({ pin: "9999" }) }), env, {})).json();
  ok(!bad.token, "כניסה לאתר עם קוד שגוי נדחית");
}

// בדיקת התקינות היומית
{
  const { kv, KV } = mkKV([["g:access", "at"], ["g:refresh", "rt"]]);
  const env = { KV, YM_TOKEN: "ym", GEMINI_KEY: "gk", BUSINESS_EMAIL: "me@example-biz.com" };
  let ymOk = false; const mails = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("gmail/v1/users/me/profile")) return new Response(JSON.stringify({ emailAddress: "me@example-biz.com" }));
    if (url.includes("messages/send")) { mails.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "s1" })); }
    if (url.includes("call2all.co.il/ym/api/GetSession")) return new Response(JSON.stringify(ymOk ? { responseStatus: "OK" } : { responseStatus: "EXCEPTION", message: "token expired" }));
    if (url.includes("generativelanguage.googleapis.com/v1beta/models?")) return new Response("{}", { status: 200 });
    throw new Error("unmocked " + url);
  };
  let failed = await healthCheck(env);
  ok(failed.length === 1 && failed[0].name === "המפתח של ימות", "בדיקת תקינות מזהה מפתח ימות שפג");
  ok(JSON.parse(kv.get("health:bad")).items[0] === "המפתח של ימות", "התקלה נשמרת להקראה בקו");
  ok(mails.length === 1, "נשלח מייל התראה על התקלה");
  ymOk = true;
  failed = await healthCheck(env);
  ok(!failed.length && !kv.has("health:bad"), "אחרי שהתקלה נפתרה – ההתראה נמחקת");
  ok(mails.length === 1, "כשהכול תקין לא נשלח מייל");
}

console.log("\nFAILS: " + fails);
if (fails) process.exit(1);

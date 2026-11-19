// גוגל צאט לריצה של Claude דרך הגשר (/bridge/gchat/<פעולה>), עם אותו חיבור לגוגל של הקו ושל אתר הצאט – בלי הרשאות חדשות.
// רק ארבע פעולות: spaces (רשימת השיחות), messages ו-thread (קריאה, בלי לסמן כנקרא), ו-send (טקסט בלבד).
// שליחה בשם שמואל נעשית רק אחרי שאישר את הנוסח בקו. הבקשה עוברת ל-API של אתר הצאט (chatsite.js)
// עם אסימון פנימי של האתר שנשמר ב-KV ומתחדש פעם בחודש.
import { logEvent, randKey, safeEq, sha } from "./base.js";
import { chatSiteApi } from "../chatsite.js";

const OPS = ["spaces", "messages", "thread", "send"];
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function siteToken(env) {
  let tok = await env.KV.get("cs:bridge-tok");
  if (tok && (await env.KV.get("cs:tok:" + (await sha(tok))))) return tok;
  tok = randKey(32);
  await env.KV.put("cs:tok:" + (await sha(tok)), "1", { expirationTtl: 30 * 86400 });
  await env.KV.put("cs:bridge-tok", tok, { expirationTtl: 29 * 86400 });
  return tok;
}

export async function gchatBridge(req, env, url) {
  const key = url.searchParams.get("k") || req.headers.get("x-bridge-key") || "";
  if (!env.BRIDGE_KEY || !(await safeEq(key, env.BRIDGE_KEY))) return J({ error: "forbidden" }, 403);
  const op = url.pathname.split("/")[3] || "";
  if (!OPS.includes(op)) return J({ error: "פעולה לא מורשית" }, 404);
  if ((op === "send") !== (req.method === "POST")) return J({ error: "שיטה לא מורשית" }, 405);
  const u = new URL(url);
  u.pathname = "/chatsite/" + op;
  u.searchParams.delete("k");
  const init = { method: "GET", headers: { "x-chat-token": await siteToken(env) } };
  if (op === "send") {
    const b = await req.json().catch(() => ({}));
    init.method = "POST";
    init.body = JSON.stringify({ space: b.space, text: String(b.text || ""), thread: b.thread || undefined });
  }
  const res = await chatSiteApi(new Request(u, init), env, u);
  if (op === "send" && res.ok) await logEvent(env, "הודעת צאט נשלחה על ידי Claude (דרך הגשר)");
  return res;
}

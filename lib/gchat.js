// גוגל צאט לריצה של Claude דרך הגשר (/bridge/gchat/<פעולה>), עם אותו חיבור לגוגל של הקו ושל אתר הצאט – בלי הרשאות חדשות.
// רק ארבע פעולות: spaces (רשימת השיחות), messages ו-thread (קריאה, בלי לסמן כנקרא), ו-send (טקסט בלבד).
// שליחה בשם שמואל נעשית רק אחרי שאישר את הנוסח בקו. הבקשה עוברת ל-API של אתר הצאט (chatsite.js)
// עם אסימון פנימי של האתר שנשמר ב-KV ומתחדש פעם בחודש.
import { logEvent, randKey, safeEq, sha } from "./base.js";
import { NotConnected, chatSend, chatSpaces, isDM, myUserId, spaceMembers, spaceMessages, userName } from "./google.js";
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

// שלוש כתובות פשוטות לאותו חיבור, ישר מול Google Chat (בלי התצוגה של האתר): GET /bridge/chat_spaces – כל השיחות,
// GET /bridge/chat_messages?space=spaces/XXX&limit=N – ההודעות האחרונות (החדשה בסוף, בלי לסמן כנקרא),
// POST /bridge/chat_send עם {space, text} – הודעת טקסט בשם שמואל (רק אחרי שאישר את הנוסח).
const CHAT_OPS = ["chat_spaces", "chat_messages", "chat_send"];
const SPACE_RE = /^spaces\/[A-Za-z0-9_-]+$/;
export const isChatBridge = (path) => CHAT_OPS.includes(path.slice(8));

export async function chatBridge(req, env, url) {
  const key = url.searchParams.get("k") || req.headers.get("x-bridge-key") || "";
  if (!env.BRIDGE_KEY || !(await safeEq(key, env.BRIDGE_KEY))) return J({ error: "forbidden" }, 403);
  const op = url.pathname.slice(8);
  if (!CHAT_OPS.includes(op)) return J({ error: "פעולה לא מורשית" }, 404);
  if ((op === "chat_send") !== (req.method === "POST")) return J({ error: "שיטה לא מורשית" }, 405);
  try {
    if (op === "chat_spaces") {
      const me = "users/" + (await myUserId(env));
      // שם של שיחה פרטית: מהמטמון של אתר הצאט, ואם אין – מרשימת החברים (עד 15 שיחות בכל בקשה, והשאר נשארות בלי שם)
      let budget = 15;
      const spaces = [];
      for (const s of (await chatSpaces(env)).slice(0, 300)) {
        let displayName = s.displayName || "";
        if (!displayName && isDM(s)) {
          const ck = "cs:title:" + s.name;
          displayName = (await env.KV.get(ck)) || "";
          if (!displayName && budget-- > 0) {
            displayName = Object.entries(await spaceMembers(env, s.name)).find(([u]) => u !== me)?.[1] || "";
            if (displayName) await env.KV.put(ck, displayName, { expirationTtl: 7 * 86400 });
          }
        }
        spaces.push({ name: s.name, displayName, type: s.spaceType || s.type || "" });
      }
      return J({ spaces });
    }
    if (op === "chat_messages") {
      const space = url.searchParams.get("space") || "";
      if (!SPACE_RE.test(space)) return J({ error: "שיחה לא תקינה" }, 400);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 20));
      const [raw, names] = await Promise.all([spaceMessages(env, space, "", limit), spaceMembers(env, space)]);
      const messages = [];
      for (const m of raw) {
        const u = m.sender?.name || "";
        messages.push({ name: m.name || "", sender: names[u] || (names[u] = await userName(env, u)), text: m.text || m.formattedText || "", at: m.createTime || "" });
      }
      return J({ messages });
    }
    const b = await req.json().catch(() => ({}));
    const space = String(b.space || ""), text = typeof b.text === "string" ? b.text : "";
    if (!SPACE_RE.test(space)) return J({ error: "שיחה לא תקינה" }, 400);
    if (!text.trim()) return J({ error: "חסר טקסט" }, 400);
    if (text.length > 4000) return J({ error: "הטקסט ארוך מדי (עד 4,000 תווים)" }, 400);
    const r = await chatSend(env, space, text);
    await logEvent(env, "הודעת צאט נשלחה על ידי Claude (דרך הגשר)");
    return J({ ok: true, name: r.name || "" });
  } catch (e) {
    if (e instanceof NotConnected) return J({ error: "אין חיבור לגוגל" }, 502);
    return J({ error: e.status ? "גוגל דחה את הבקשה (" + e.status + ")" : "שגיאה בשרת" }, 502);
  }
}

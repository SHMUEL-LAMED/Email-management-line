// לשילוב ב-worker.js: להכניס את הקוד הזה לפני async function bridgeApi, ובתוך fetch להוסיף אחרי שורת /bridge/:
//     if (path.startsWith("/chatsite/")) return chatSiteApi(req, env, url);
// ואז להעביר את pending/sim-chatsite.mjs לתיקייה test/ (הבדיקה עוברת).
// ---------------------------------------------------------------- אתר הצאט (shmuel-lamed.github.io/chat)
// האתר בגיטהאב פונה לכאן. כניסה עם הקוד הסודי של הקו; מקבלים אסימון לחודש (נשמר ב-KV רק כ-hash).
const CHAT_SITE_ORIGINS = ["https://shmuel-lamed.github.io"];
async function chatSiteApi(req, env, url) {
  const origin = req.headers.get("origin") || "";
  const cors = {
    "access-control-allow-origin": CHAT_SITE_ORIGINS.includes(origin) ? origin : CHAT_SITE_ORIGINS[0],
    "access-control-allow-headers": "content-type, x-chat-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const op = url.pathname.split("/")[2] || "";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  try {
    if (op === "login") {
      const fails = +(await env.KV.get("pinfails")) || 0;
      if (fails >= 6) return J({ error: "הכניסה חסומה לשעה בגלל ניסיונות שגויים" }, 429);
      if (!body.pin || (await sha(String(body.pin))) !== (await currentPinHash(env))) {
        const f = fails + 1;
        await env.KV.put("pinfails", String(f), { expirationTtl: 3600 });
        await logEvent(env, "קוד שגוי בכניסה לאתר הצאט");
        if (f >= 6) await logEvent(env, "הקו והאתר ננעלו לשעה אחרי 6 קודים שגויים");
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
    const spaceOk = (s) => /^spaces\/[\w-]+$/.test(String(s || ""));

    if (op === "spaces") {
      const me = await myUserId(env);
      const mute = await kvJson(env, "mute", []);
      const spaces = (await chatSpaces(env)).slice(0, 40);
      const list = await Promise.all(spaces.map(async (s) => {
        let title = s.displayName || "";
        if (isDM(s)) {
          const ck = "cs:title:" + s.name;
          title = (await env.KV.get(ck)) || "";
          if (!title) {
            const names = await spaceMembers(env, s.name);
            title = Object.entries(names).find(([u]) => u !== "users/" + me)?.[1] || "";
            if (title) await env.KV.put(ck, title, { expirationTtl: 7 * 86400 });
          }
        }
        const lr = await readState(env, s.name);
        return { space: s.name, dm: isDM(s), title: title || (isDM(s) ? "איש קשר" : "קבוצה בלי שם"), last: s.lastActiveTime || "", unread: !!(s.lastActiveTime && s.lastActiveTime > lr), muted: mute.includes(s.name) };
      }));
      return J({ spaces: list });
    }
    if (op === "messages") {
      const space = url.searchParams.get("space");
      if (!spaceOk(space)) return J({ error: "שיחה לא תקינה" }, 400);
      const me = await myUserId(env);
      const [raw, names] = await Promise.all([spaceMessages(env, space, null, 50), spaceMembers(env, space)]);
      const msgs = [];
      for (const m of raw) {
        const u = m.sender?.name || "";
        msgs.push({ id: m.name || "", mine: u === "users/" + me, who: names[u] || (await userName(env, u)), text: String(m.text || m.formattedText || ""), at: m.createTime || "", atts: (m.attachment || []).map((a) => a.contentName || "קובץ") });
      }
      return J({ messages: msgs });
    }
    if (op === "send") {
      if (!spaceOk(body.space) || !String(body.text || "").trim()) return J({ error: "חסר טקסט או שיחה" }, 400);
      const r = await chatSend(env, body.space, String(body.text).slice(0, 4000));
      await chatMarkRead(env, body.space).catch(() => {});
      return J({ ok: true, id: r.name || "" });
    }
    if (op === "read") {
      if (!spaceOk(body.space)) return J({ error: "שיחה לא תקינה" }, 400);
      await chatMarkRead(env, body.space);
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
      const [raw, names] = await Promise.all([spaceMessages(env, body.space, null, 50), spaceMembers(env, body.space)]);
      const lines = [];
      for (const m of raw) lines.push(`${names[m.sender?.name] || (await userName(env, m.sender?.name))}: ${msgText(m)}`);
      if (!lines.length) return J({ summary: "אין הודעות בשיחה." });
      const s = await llm(env, "סכם בעברית, בקצרה ובנקודות, את השיחה הבאה מצאט: מה נדון, מה סוכם, ומה מחכה לתשובה ממני.", lines.join("\n").slice(-12000), 600);
      return J({ summary: s });
    }
    return J({ error: "unknown" }, 404);
  } catch (e) {
    if (e instanceof NotConnected) return J({ error: "החשבון של גוגל לא מחובר לקו" }, 503);
    await logEvent(env, "שגיאה באתר הצאט: " + String(e.message || e).slice(0, 150));
    return J({ error: "שגיאה בשרת" }, 500);
  }
}

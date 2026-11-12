import { H, R, SP0, YM, cleanForSpeech, kvJson, logEvent, say, sha, text, trimText, unb64url } from "./base.js";
import { CAT_NAME, geminiBusy, gmailSend, isBusy, markBusy } from "./google.js";
import { nowIL } from "./assistant.js";
import { go } from "./flow.js";

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
          contents: [{ parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.TTS_VOICE || "Orus" } } } },
        }),
        signal: AbortSignal.timeout(Math.min(12000, left)),
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
  const key = (await sha("v2|" + (env.TTS_VOICE || "Orus") + "|" + text)).slice(0, 24);
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

export { bump, decSp, SP_RE, renderPlain, voiceMode, voiceOn, renderSpeech, cleanForVoice, chunkText, voiceSay, sentenceChunks, pcmToWav, ttsRound, ttsBytes, ttsFile, saveResume, securityAlert };

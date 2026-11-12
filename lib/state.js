import { kvJson, logEvent, text } from "./base.js";
import { runJob } from "./assistant.js";

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

export { bridgeOp, bridge, stub, getJob, setJob, loadState, saveState, BUSY_MS, claimInput, busyOf, dropState };

// סימולציה: סרטון מצורף והקלטה בצאט + קישור יוטיוב
import worker from "../worker.js";

const kv = new Map([["namehints", JSON.stringify({ t: Date.now(), s: "" })], ["g:refresh", "rt"], ["g:me", "111"]]);
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const env = { KV, AI: { run: async () => ({ text: "" }) }, YM_TOKEN: "ym", PIN: "1234", PATH_KEY: "pk", SETUP_KEY: "sk", GEMINI_KEY: "gk", ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "x@y.com" };
const uploads = [];
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("oauth2")) return json({ access_token: "at", expires_in: 3600 });
  if (url.endsWith("spaces/DM1/messages?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD")) { console.log("   [נשלח לצאט]", init.body); return json({ name: "x" }); }
  if (url.includes("messages?q=")) return json({});
  if (url.includes("chat.googleapis.com/v1/spaces?")) return json({ spaces: [{ name: "spaces/DM1", spaceType: "DIRECT_MESSAGE", lastActiveTime: new Date().toISOString() }] });
  if (url.includes("spaceReadState")) return json({ lastReadTime: "2026-10-10T00:00:00Z" });
  if (url.includes("spaces/DM1/messages?")) return json({ messages: [
    { name: "spaces/DM1/messages/M0", createTime: "2026-10-11T05:00:00Z", thread: { name: "spaces/DM1/threads/T0" }, sender: { name: "users/222" }, text: "תראה את זה https://youtu.be/dQw4w9WgXcQ" },
    { sender: { name: "users/222" }, text: "", attachment: [{ contentName: "VID-2026.mp4", contentType: "video/mp4", attachmentDataRef: { resourceName: "spaces/DM1/messages/M1/attachments/A1" } }] },
  ] });
  if (url.includes("spaces/DM1/members")) return json({ memberships: [{ member: { name: "users/111", displayName: "שמואל" } }, { member: { name: "users/222", displayName: "דוד לוי" } }] });
  if (url.includes("chat.googleapis.com/v1/media/")) return new Response(new Uint8Array(50000), { headers: { "content-length": "50000" } });
  if (url.includes("youtube/v3/videos")) return json({ items: [{ id: "dQw4w9WgXcQ", snippet: { title: "שיעור בגמרא", channelTitle: "ערוץ" }, contentDetails: { duration: "PT12M5S" } }] });
  if (url.includes("generativelanguage")) {
    const b = JSON.parse(init.body);
    const yt = b.contents[0].parts.find((p) => p.file_data);
    return json({ candidates: [{ content: { parts: [{ text: yt ? "הסרטון עוסק בשיעור בגמרא. ".repeat(200) : "x" }] } }] });
  }
  if (url.includes("UploadFile")) { uploads.push("upload"); return json({ responseStatus: "OK" }); }
  if (url.includes("call2all")) return json({});
  throw new Error("unmocked " + url);
};
const pending = [];
const ectx = { waitUntil: (p) => pending.push(p) };
const vals = { ApiCallId: "m1", ApiPhone: "0500000000" };
let out = "";
async function phone(v) {
  await Promise.all(pending.splice(0));
  if (v !== undefined) { const k = [...out.matchAll(/=(V\d+),/g)].pop()[1]; vals[k] = v; console.log(">>", v); }
  const u = new URL("https://w.dev/yemot/pk");
  for (const [k, x] of Object.entries(vals)) u.searchParams.set(k, x);
  out = await (await worker.fetch(new Request(u), env, ectx)).text();
  console.log("<<", out.replace(/=V\d+,.*$/, "").slice(0, 330));
}
await phone(); await phone("1234"); await phone("2");
await phone("5");          // media list
await phone("1");          // the video file
await phone("none");       // poll -> ready
await phone("0");          // back to conversation menu
await phone("5"); await phone("2");  // youtube
await phone("1");          // summary
await phone("none");
await phone("1");          // next page
await phone("0");          // back
await phone("5"); await phone("2"); await phone("3"); await phone("1");  // ask for file in thread
console.log("uploads:", uploads.length);

// סימולציה של העוזר החכם: AI מדומה שמחליט על כלים לפי הבקשה
import worker from "../worker.js";

const kv = new Map();
const KV = { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, String(v)); }, delete: async (k) => { kv.delete(k); } };
const env = {
  KV, AI: { run: async () => ({ response: "" }) },
  YM_TOKEN: "ym", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "cs", GEMINI_KEY: "gk",
  PIN: "1234", PATH_KEY: "pk", SETUP_KEY: "sk", ALLOWED_PHONES: "0500000000", BUSINESS_EMAIL: "me@example-biz.com",
};
kv.set("g:refresh", "rt");
const done = [];
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
let said = "";

globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init.method || "GET";
  if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
  if (url.includes("generativelanguage")) {
    const body = JSON.parse(init.body);
    const parts = body.contents.flatMap((c) => c.parts);
    if (parts.some((p) => p.inline_data)) return json({ candidates: [{ content: { parts: [{ text: said }] } }] });
    if (!body.tools) return json({ candidates: [{ content: { parts: [{ text: "תרגום" }] } }] });
    const lastUser = [...body.contents].reverse().find((c) => c.role === "user");
    const fr = lastUser.parts.find((p) => p.functionResponse);
    const text = body.contents.filter((c) => c.role === "user").map((c) => c.parts.map((p) => p.text || "").join(" ")).pop().split("\n").pop();
    const fc = (name, args) => json({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });
    if (fr?.functionResponse.name === "search_email") return fc("play_email", { id: "m1" });
    if (fr?.functionResponse.name === "search_contacts") return fc("send_email", { to: "yossi@ex.com", subject: "איחור", body: "אני מאחר בעשר דקות" });
    if (/בחרתי בתפריט/.test(text)) return fc("play_email", { id: "m1" });
    if (/מייל מדוד/.test(text)) return fc("ask_choice", { question: "יש שני מיילים מדוד. איזה?", options: ["דוד לוי בנושא פגישה", "דוד כהן בנושא חשבון"] });
    if (/מייל מיוסי/.test(text)) return fc("search_email", { query: "from:(yossi OR יוסי)" });
    if (/תשלח ליוסי/.test(text)) return fc("search_contacts", { name: "יוסי" });
    return json({ candidates: [{ content: { parts: [{ text: "יש לך פגישה מחר בעשר." }] } }] });
  }
  if (url.includes("messages?q=")) return json({ messages: [{ id: "m1" }] });
  if (url.includes("messages/m1?format=metadata")) return json({ id: "m1", labelIds: ["INBOX", "UNREAD"], snippet: "שלום", payload: { headers: [{ name: "From", value: '"יוסי כהן" <yossi@ex.com>' }, { name: "Subject", value: "הדוח" }] } });
  if (url.includes("messages/m1?format=full")) return json({ id: "m1", threadId: "t1", snippet: "שלום", payload: { headers: [{ name: "From", value: '"יוסי כהן" <yossi@ex.com>' }, { name: "Subject", value: "הדוח" }], mimeType: "text/plain", body: { data: b64u("שלום שמואל, הדוח מוכן ומצורף.") } } });
  if (url.endsWith("messages/send")) { done.push("EMAIL SENT"); return json({}); }
  if (url.includes("people/me/connections")) return json({ connections: [{ names: [{ displayName: "יוסי כהן" }], emailAddresses: [{ value: "yossi@ex.com" }] }] });
  if (url.includes("listDirectoryPeople") || url.includes("otherContacts")) return json({});
  if (url.includes("call2all") && url.includes("DownloadFile")) return new Response(new Uint8Array(said ? 5000 : 500).fill(1));
  if (url.includes("searchDirectoryPeople")) return json({ people: [{ resourceName: "people/111", emailAddresses: [{ value: "me@example-biz.com" }] }] });
  if (url.includes("call2all")) return json({});
  if (url.includes("chat.googleapis.com/v1/spaces?")) return json({ spaces: [] });
  throw new Error("unmocked " + method + " " + url);
};

const pending = [];
const ectx = { waitUntil: (p) => pending.push(p) };
const vals = { ApiCallId: "ai1", ApiPhone: "0500000000" };
let out = "";
async function req() {
  await Promise.all(pending.splice(0));
  const u = new URL("https://w.dev/yemot/pk");
  for (const [k, v] of Object.entries(vals)) u.searchParams.set(k, v);
  out = await (await worker.fetch(new Request(u), env, ectx)).text();
  console.log("<<", out.replace(/=V\d+,.*$/, "").slice(0, 300));
}
async function send(v, sayText) {
  const k = [...out.matchAll(/=(V\d+),/g)].pop()[1];
  if (sayText !== undefined) { said = sayText; vals[k] = "/rec/" + k + ".wav"; console.log(">> [אומר]", sayText); }
  else { vals[k] = v; console.log(">>", v); }
  await req();
}
await req();
await send("1234");
await send("6");
await send(null, "תשמיע לי את המייל מיוסי");
await send("none");           // poll -> job finished
await send("1");              // single confirm -> plays
await send(null, "תשלח ליוסי מייל שאני מאחר");
await send("none");
await send("1");              // first confirm
await send("1");              // second confirm -> sent
await send(null, "מה יש לי מחר");
await send("none");
await send(null, "תשלח ליוסי מייל שאני מאחר");
await send("none");
await send("2");              // cancel
await send(null, "תשמיע לי מייל מדוד");
await send("none");
await send("2");              // pick option 2
await send("none");
await send("1");              // confirm play
await send(null, "");         // nothing said -> exit to main
await send("none");
console.log("\nactions:", done);
console.log("log:", kv.get("log"));

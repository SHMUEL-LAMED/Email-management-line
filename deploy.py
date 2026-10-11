# העלאת ה-Worker ל-Cloudflare דרך ה-API
# שימוש: python3 deploy.py <scratchpad-dir>
import json, sys, uuid, urllib.request

S = sys.argv[1]
TOKEN = open(f"{S}/.cf_token").read().strip()
ACC = "7c5ecc8cc6dc99838cfbf1b3a1086b74"
NAME = "yemot-mail"
sec = json.load(open(f"{S}/secrets.json"))
kv_id = open(f"{S}/kv_id").read().strip()
code = open("/home/claude/yemot-mail/worker.js", "rb").read()

bindings = [
    {"type": "kv_namespace", "name": "KV", "namespace_id": kv_id},
    {"type": "ai", "name": "AI"},
    {"type": "durable_object_namespace", "name": "CALLS", "class_name": "CallState"},
    {"type": "plain_text", "name": "ALLOWED_PHONES", "text": sec["ALLOWED_PHONES"]},
    {"type": "plain_text", "name": "BUSINESS_EMAIL", "text": sec["BUSINESS_EMAIL"]},
]
for k in ("YM_TOKEN", "PIN", "PATH_KEY", "SETUP_KEY", "GOOGLE_CLIENT_SECRET", "GEMINI_KEY", "BRIDGE_KEY"):
    if sec.get(k):
        bindings.append({"type": "secret_text", "name": k, "text": sec[k]})
import os
if os.path.exists(f"{S}/sa_worker.json"):
    bindings.append({"type": "secret_text", "name": "GOOGLE_SA_KEY", "text": open(f"{S}/sa_worker.json").read()})
if sec.get("GOOGLE_CLIENT_ID"):
    bindings.append({"type": "plain_text", "name": "GOOGLE_CLIENT_ID", "text": sec["GOOGLE_CLIENT_ID"]})

meta = {"main_module": "worker.js", "compatibility_date": "2025-09-01", "bindings": bindings}
# יצירת מחלקת ה-Durable Object בפעם הראשונה בלבד
req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}/settings", headers={"Authorization": f"Bearer {TOKEN}"})
try:
    cur = json.load(urllib.request.urlopen(req, timeout=30))["result"]
    has_do = any(b.get("type") == "durable_object_namespace" for b in cur.get("bindings", []))
except Exception:
    has_do = False
if not has_do:
    meta["migrations"] = {"new_tag": "v1", "new_sqlite_classes": ["CallState"]}
b = uuid.uuid4().hex
body = (
    f"--{b}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
    f"--{b}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n"
).encode() + code + f"\r\n--{b}--\r\n".encode()

def call(method, path, data=None, ctype="application/json"):
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": ctype})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return json.load(e)

r = call("PUT", f"/workers/scripts/{NAME}", body, f"multipart/form-data; boundary={b}")
print("upload:", r.get("success"), r.get("errors"))
r = call("POST", f"/workers/scripts/{NAME}/subdomain", json.dumps({"enabled": True, "previews_enabled": False}).encode())
print("workers.dev:", r.get("success"), r.get("errors"))

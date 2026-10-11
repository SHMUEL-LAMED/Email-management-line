# העלאת קוד בלבד ל-Cloudflare: שומר את כל הסודות וההגדרות הקיימות (keep_bindings)
# שימוש: CF_TOKEN=... python3 deploy_code.py
import json, os, sys, uuid, urllib.request

TOKEN = os.environ.get("CF_TOKEN") or sys.exit("חסר CF_TOKEN")
ACC = "7c5ecc8cc6dc99838cfbf1b3a1086b74"
NAME = "yemot-mail"
code = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.js"), "rb").read()
meta = {
    "main_module": "worker.js",
    "compatibility_date": "2025-09-01",
    "keep_bindings": ["secret_text", "plain_text", "kv_namespace", "ai", "durable_object_namespace"],
}
b = uuid.uuid4().hex
body = (
    f"--{b}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
    f"--{b}\r\nContent-Disposition: form-data; name=\"worker.js\"; filename=\"worker.js\"\r\nContent-Type: application/javascript+module\r\n\r\n"
).encode() + code + f"\r\n--{b}--\r\n".encode()
req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}", data=body, method="PUT",
                             headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": f"multipart/form-data; boundary={b}"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=60))
except urllib.error.HTTPError as e:
    r = json.load(e)
print("upload:", r.get("success"), r.get("errors"))
# משימה מתוזמנת של Cloudflare: כל 15 דקות (דחיות מייל, סיכום יומי בערב)
req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}/schedules", data=json.dumps([{"cron": "*/15 * * * *"}]).encode(), method="PUT",
                             headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
try:
    r = json.load(urllib.request.urlopen(req, timeout=60))
except urllib.error.HTTPError as e:
    r = json.load(e)
print("cron:", r.get("success"), r.get("errors"))

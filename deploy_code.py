# העלאת קוד בלבד ל-Cloudflare: שומר את כל הסודות וההגדרות הקיימות (keep_bindings)
# שימוש: CF_TOKEN=... python3 deploy_code.py [--code-only]
import email, json, os, sys, uuid, urllib.request

ACC = "7c5ecc8cc6dc99838cfbf1b3a1086b74"
NAME = "yemot-mail"
HERE = os.path.dirname(os.path.abspath(__file__))
# המודולים שעולים: entry.js (נקודת הכניסה) מחבר את worker.js (הקו) ואת chatsite.js (אתר הצאט).
# worker.js מחבר את כל הקוד שבתיקייה lib/ (עולה עם הנתיב שלו, למשל lib/base.js).
MODULES = ["entry.js", "worker.js", "chatsite.js"] + sorted("lib/" + f for f in os.listdir(os.path.join(HERE, "lib")) if f.endswith(".js"))
MAIN = "entry.js"
COMPAT = "2025-09-01"
KEEP = ["secret_text", "plain_text", "kv_namespace", "ai", "durable_object_namespace"]
# גשר הווידאו (מאגר 07, scripts/deploy-news-archive.py) מוזרק לסוף worker.js בשרת החי.
# כדי שפריסה של הקו לא תמחק אותו, לוקחים אותו מהגרסה החיה ומחברים אותו שוב לקוד החדש.
BRIDGE_MARKER = "\n\nconst newsVideoAuth="


def api(token, method, path, data=None, ctype="application/json"):
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": ctype})
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        return json.load(e)


def live_bridge(token):
    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}/content/v2",
                                 headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            ctype, raw = r.headers.get("Content-Type", ""), r.read()
    except Exception as e:
        print("אזהרה: לא הצלחתי לקרוא את הגרסה החיה (גשר הווידאו לא נשמר):", e)
        return ""
    msg = email.message_from_bytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    for part in msg.walk():
        if part.is_multipart():
            continue
        name = part.get_param("name", header="content-disposition") or part.get_filename()
        if name == "worker.js":
            code = part.get_payload(decode=True).decode("utf-8")
            i = code.find(BRIDGE_MARKER)
            return code[i:] if i >= 0 and "const originalMailWorker = {" in code else ""
    return ""


def module_code(m, bridge):
    code = open(os.path.join(HERE, m), "rb").read()
    if m != "worker.js" or not bridge:
        return code
    text = code.decode("utf-8")
    if text.count("export default {") != 1 or "const newsVideoAuth=" in text:
        sys.exit("worker.js במבנה לא צפוי – עצרתי כדי לא לשבור את גשר הווידאו")
    return (text.replace("export default {", "const originalMailWorker = {", 1) + bridge).encode("utf-8")


def upload(token, meta):
    """מעלה את כל המודולים עם ה-metadata הנתון, ומחבר את גשר הווידאו מהגרסה החיה."""
    bridge = live_bridge(token)
    print("גשר הווידאו:", "נשמר" if bridge else "לא נמצא בגרסה החיה (יוחזר בהרצה הבאה של התהליך במאגר 07 עם repair_archive)")
    b = uuid.uuid4().hex
    body = f"--{b}\r\nContent-Disposition: form-data; name=\"metadata\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n".encode()
    for m in MODULES:
        body += f"--{b}\r\nContent-Disposition: form-data; name=\"{m}\"; filename=\"{m}\"\r\nContent-Type: application/javascript+module\r\n\r\n".encode()
        body += module_code(m, bridge) + b"\r\n"
    body += f"--{b}--\r\n".encode()
    r = api(token, "PUT", f"/workers/scripts/{NAME}", body, f"multipart/form-data; boundary={b}")
    print("upload:", r.get("success"), r.get("errors"))
    if not r.get("success"):
        sys.exit(1)


def set_cron(token):
    # משימה מתוזמנת של Cloudflare: כל 15 דקות (דחיות מייל, סיכום יומי בערב, בדיקת תקינות)
    r = api(token, "PUT", f"/workers/scripts/{NAME}/schedules", json.dumps([{"cron": "*/15 * * * *"}]).encode())
    print("cron:", r.get("success"), r.get("errors"))
    if not r.get("success"):
        sys.exit(1)


def main():
    token = os.environ.get("CF_TOKEN") or sys.exit("חסר CF_TOKEN")
    upload(token, {"main_module": MAIN, "compatibility_date": COMPAT, "keep_bindings": KEEP})
    if "--code-only" not in sys.argv[1:]:
        set_cron(token)


if __name__ == "__main__":
    main()

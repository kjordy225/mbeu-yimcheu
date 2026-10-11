#!/usr/bin/env python3
"""Back up the whole family database (Firestore) to one JSON file on this computer.

Uses the Firebase CLI login of this Mac (run `npx firebase-tools login` once).
Backups hold private family data: they are written OUTSIDE this public repository,
by default to ~/Backups/mbeu-yimcheu/, and the newest KEEP files are kept.

    python3 tools/backup.py            # make a backup
    python3 tools/backup.py --check    # only list what the latest backup contains
"""
import datetime, glob, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

PROJECT = "mbeu-yimcheu"
OUT_DIR = os.path.expanduser(os.environ.get("MBEU_BACKUP_DIR", "~/Backups/mbeu-yimcheu"))
KEEP = 60
CLI_CONFIG = os.path.expanduser("~/.config/configstore/firebase-tools.json")
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents"


def cli_tokens():
    with open(CLI_CONFIG) as f:
        return json.load(f).get("tokens", {})


def access_token():
    t = cli_tokens()
    if not t.get("access_token") or t.get("expires_at", 0) < (time.time() + 120) * 1000:
        # Any CLI call that talks to Google refreshes the saved token.
        env = dict(os.environ, PATH="/usr/local/bin:/opt/homebrew/bin:" + os.environ.get("PATH", ""))
        subprocess.run(["npx", "-y", "firebase-tools", "projects:list"], env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
        t = cli_tokens()
    if not t.get("access_token"):
        sys.exit("Not logged in to Firebase. Run: npx firebase-tools login")
    return t["access_token"]


def call(url, token, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token, "x-goog-user-project": PROJECT,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def collection_ids(token):
    ids, page = [], ""
    while True:
        body = {"pageSize": 100}
        if page:
            body["pageToken"] = page
        r = call(BASE + ":listCollectionIds", token, body)
        ids += r.get("collectionIds", [])
        page = r.get("nextPageToken", "")
        if not page:
            return sorted(ids)


def documents(col, token):
    docs, page = [], ""
    while True:
        q = {"pageSize": 300}
        if page:
            q["pageToken"] = page
        r = call(f"{BASE}/{urllib.parse.quote(col)}?{urllib.parse.urlencode(q)}", token)
        docs += r.get("documents", [])
        page = r.get("nextPageToken", "")
        if not page:
            return docs


def latest():
    files = sorted(glob.glob(os.path.join(OUT_DIR, "backup-*.json")))
    return files[-1] if files else None


def check():
    f = latest()
    if not f:
        sys.exit("No backup found in " + OUT_DIR)
    data = json.load(open(f))
    print(f, "—", data["takenAt"])
    for col, docs in data["collections"].items():
        print(f"  {col}: {len(docs)}")


def main():
    if "--check" in sys.argv:
        return check()
    token = access_token()
    now = datetime.datetime.now(datetime.timezone.utc)
    # Documents are kept in Firestore's own typed format so they can be restored exactly.
    data = {"project": PROJECT, "takenAt": now.isoformat(), "format": "firestore-rest-v1", "collections": {}}
    for col in collection_ids(token):
        data["collections"][col] = documents(col, token)
    os.makedirs(OUT_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(OUT_DIR, now.astimezone().strftime("backup-%Y-%m-%d-%H%M.json"))
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(data, f, ensure_ascii=False)
    for old in sorted(glob.glob(os.path.join(OUT_DIR, "backup-*.json")))[:-KEEP]:
        os.remove(old)
    total = sum(len(d) for d in data["collections"].values())
    print(f"Saved {total} documents to {path}")
    for col, docs in data["collections"].items():
        print(f"  {col}: {len(docs)}")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.HTTPError as e:
        sys.exit(f"Backup failed: HTTP {e.code} {e.read().decode()[:300]}")

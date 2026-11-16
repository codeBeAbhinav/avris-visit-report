#!/usr/bin/env python3
"""
AVRIS Visit Report, web backend.

One shared library of site visit reports for the whole team.
There are no accounts: anyone with the team link can open it, fill a report,
send it and download it. The link carries a team access key (ACCESS_KEY).
Every change is stored on the server, versioned and logged, so all devices
see the same data.

Report logic (layout, PDF / Word / CSV export) lives in avris_core.py,
taken from the desktop version.

Run locally:   python3 app.py
Run on a host: gunicorn -w 1 --threads 8 -b 0.0.0.0:$PORT app:app
See README.md and .env.example.
"""
import copy
import csv
import hmac
import io
import json
import logging
import os
import re
import secrets
import smtplib
import sqlite3
import ssl
import tempfile
import threading
import time
import uuid
import zipfile
from collections import defaultdict, deque
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import unquote
from zoneinfo import ZoneInfo

from flask import Flask, Response, abort, g, jsonify, request, send_file, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR") or os.environ.get("AVRIS_DATA") or (BASE_DIR / "data")).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
os.environ["AVRIS_DATA"] = str(DATA_DIR)   # avris_core reads this at import

import avris_core as core  # noqa: E402

try:
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 60_000_000
except Exception:  # pragma: no cover
    Image = ImageOps = None

DB_PATH = DATA_DIR / "avris.db"
PHOTO_DIR = DATA_DIR / "photos"
PHOTO_DIR.mkdir(parents=True, exist_ok=True)
TZ = ZoneInfo(os.environ.get("TZ_NAME", "Asia/Kolkata"))
ACCESS_KEY = os.environ.get("ACCESS_KEY", "")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
ALLOWED_EMAIL_DOMAINS = [d.strip().lower().lstrip("@") for d in os.environ.get("ALLOWED_EMAIL_DOMAINS", "").split(",") if d.strip()]
TRASH_DAYS = int(os.environ.get("TRASH_DAYS", "60"))
MAX_PHOTOS = 24
PRESENCE_SECONDS = 25
log = logging.getLogger("avris")
logging.basicConfig(level=logging.INFO)

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
app.config.update(MAX_CONTENT_LENGTH=int(os.environ.get("MAX_UPLOAD_MB", "30")) * 1024 * 1024)


# ------------------------------------------------------------------ database
SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'draft',
  lead_status TEXT NOT NULL DEFAULT 'New',
  version INTEGER NOT NULL DEFAULT 1,
  report_no TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT '',
  visit_date TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,
  email_status TEXT NOT NULL DEFAULT '',
  email_at TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_no ON reports(report_no);
CREATE INDEX IF NOT EXISTS reports_updated ON reports(updated);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  who TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_report ON events(report_id, id);
CREATE TABLE IF NOT EXISTS presence (
  report_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  seen REAL NOT NULL,
  PRIMARY KEY (report_id, client_id)
);
CREATE TABLE IF NOT EXISTS counters (fy TEXT PRIMARY KEY, n INTEGER NOT NULL);
"""


def open_db():
    con = sqlite3.connect(DB_PATH, timeout=20, isolation_level=None)   # autocommit; transactions are explicit
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


def db():
    if "db" not in g:
        g.db = open_db()
    return g.db


@app.teardown_appcontext
def close_db(_e):
    con = g.pop("db", None)
    if con is not None:
        con.close()


@contextmanager
def tx(con=None):
    """Serialised read-modify-write. BEGIN IMMEDIATE takes the write lock up front so two people
    saving at the same moment can never overwrite each other's changes."""
    con = con or db()
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db():
    con = open_db()
    con.executescript(SCHEMA)
    purge_trash(con)
    con.close()


def purge_trash(con):
    if TRASH_DAYS <= 0:
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=TRASH_DAYS)).isoformat(timespec="seconds")
    for row in con.execute("SELECT * FROM reports WHERE deleted_at != '' AND deleted_at < ?", (cutoff,)).fetchall():
        for p in json.loads(row["data"]).get("photos", []):
            try:
                (PHOTO_DIR / p["file"]).unlink()
            except OSError:
                pass
        con.execute("DELETE FROM reports WHERE id=?", (row["id"],))
        con.execute("DELETE FROM events WHERE report_id=?", (row["id"],))
        con.execute("DELETE FROM presence WHERE report_id=?", (row["id"],))


# ------------------------------------------------------------------ identity and access
CLEAN_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_key_fails = defaultdict(lambda: [0, 0.0])


class BadInput(Exception):
    pass


def clean_str(v, cap=4000):
    if not isinstance(v, str):
        raise BadInput("expected text")
    return CLEAN_RE.sub("", v)[:cap]


@app.before_request
def guard():
    g.client_id = re.sub(r"[^A-Za-z0-9_-]", "", request.headers.get("X-Client-Id", ""))[:64] or "anon"
    g.client_name = CLEAN_RE.sub("", unquote(request.headers.get("X-Client-Name", ""))).strip()[:60] or "Someone"
    if request.method == "OPTIONS" or not request.path.startswith("/api/") or request.path == "/api/health":
        return None
    if ACCESS_KEY:
        ip = request.remote_addr or "?"
        n, t0 = _key_fails[ip]
        if time.time() - t0 > 600:
            n, t0 = 0, time.time()
        if n >= 30:
            return jsonify(error="Too many wrong keys. Try again in a few minutes.", code="locked"), 429
        sent = request.headers.get("X-Access-Key", "")
        if not hmac.compare_digest(sent.encode(), ACCESS_KEY.encode()):
            _key_fails[ip] = [n + 1 if sent else n, t0 or time.time()]
            return jsonify(error="This link needs the team access key.", code="key"), 401
    return None


@app.after_request
def headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    if request.path.startswith("/api/"):
        origin = request.headers.get("Origin")
        if origin and ("*" in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS):
            resp.headers["Access-Control-Allow-Origin"] = "*" if "*" in ALLOWED_ORIGINS else origin
            resp.headers["Vary"] = "Origin"
            resp.headers["Access-Control-Allow-Headers"] = ("Content-Type, X-Access-Key, X-Client-Id, "
                                                            "X-Client-Name, X-Requested-With")
            resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
            resp.headers["Access-Control-Expose-Headers"] = "Content-Disposition"
            resp.headers["Access-Control-Max-Age"] = "600"
        resp.headers["Cache-Control"] = "private, max-age=3600" if "/photos/" in request.path else "no-store"
    else:
        resp.headers["X-Frame-Options"] = os.environ.get("X_FRAME_OPTIONS", "DENY")
    return resp


@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(405)
@app.errorhandler(409)
@app.errorhandler(413)
@app.errorhandler(429)
def http_error(e):
    msg = getattr(e, "description", "") or "Error"
    if e.code == 413:
        msg = "Upload too large."
    return jsonify(error=msg), e.code


@app.errorhandler(BadInput)
def bad_input(e):
    return jsonify(error=str(e)), 400


@app.errorhandler(sqlite3.IntegrityError)
def integrity(e):
    if "report_no" in str(e):
        return jsonify(error="That report number is already used by another report."), 409
    raise e


# ------------------------------------------------------------------ report model
TEMPLATE = core.new_report(0)
META_KEYS = ("id", "status", "lead_status", "step", "updated")
EDITABLE = [k for k in TEMPLATE if k not in META_KEYS + ("photos",)]
CHOICE_FIELDS = {"site_type": core.SITE_TYPES, "op_days": core.OP_DAYS, "nonveg": core.NONVEG,
                 "segregated": core.SEGREGATED, "plant_size": core.PLANT_SIZES, "followup": core.FOLLOWUP}
MULTI_FIELDS = {"issues": core.ISSUES, "includes": core.INCLUDES}


def clean_signature(v):
    if not isinstance(v, list) or len(v) > 300:
        raise BadInput("bad signature")
    out, total = [], 0
    for st in v:
        if not isinstance(st, list) or len(st) > 3000:
            raise BadInput("bad signature")
        pts = []
        for pt in st:
            if (not isinstance(pt, (list, tuple)) or len(pt) != 2
                    or not all(isinstance(n, (int, float)) and -50 <= n <= 3000 for n in pt)):
                raise BadInput("bad signature")
            pts.append([round(float(pt[0]), 1), round(float(pt[1]), 1)])
        total += len(pts)
        if total > 20000:
            raise BadInput("signature too long")
        out.append(pts)
    return out


def clean_people(v):
    if not isinstance(v, list) or not 1 <= len(v) <= 10:
        raise BadInput("bad people list")
    out = []
    for p in v:
        if not isinstance(p, dict):
            raise BadInput("bad person")
        out.append({k: clean_str(p.get(k, ""), 300) for k in ("name", "designation", "contact", "email")})
    return out


def clean_field(key, v):
    if key in CHOICE_FIELDS:
        v = clean_str(v, 100)
        if v and v not in CHOICE_FIELDS[key]:
            raise BadInput(f"invalid value for {key}")
        return v
    if key in MULTI_FIELDS:
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise BadInput(f"invalid value for {key}")
        return [o for o in MULTI_FIELDS[key] if o in v]
    if key == "people":
        return clean_people(v)
    if key == "prepared_sig":
        return clean_signature(v)
    return clean_str(v, 4000)


def row_to_report(row):
    r = json.loads(row["data"])
    for k, v in TEMPLATE.items():
        r.setdefault(k, copy.deepcopy(v))
    r.update(id=row["id"], status=row["status"], lead_status=row["lead_status"], updated=row["updated"])
    return r


def core_view(r):
    """The report as avris_core expects it: photos carry a local path."""
    c = dict(r)
    c["photos"] = [{"path": str(PHOTO_DIR / p["file"]), "caption": p.get("caption", ""), "tag": p.get("tag", "")}
                   for p in r["photos"]]
    return c


def get_row(con, rid):
    row = con.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
    if row is None:
        abort(404, "Report not found.")
    return row


def save_data(con, rid, r, *, status=None, lead=None, email_status=None, deleted=None, sent_at=None):
    """Write the report and bump its version. Must run inside tx()."""
    data = {k: v for k, v in r.items() if k not in META_KEYS}
    sets = ["data=?", "report_no=?", "customer=?", "visit_date=?", "version=version+1", "updated=?", "updated_by=?"]
    args = [json.dumps(data, ensure_ascii=False), r["report_no"], r["customer"], r["visit_date"],
            now_iso(), g.client_name]
    for col, val in (("status", status), ("lead_status", lead), ("email_status", email_status),
                     ("deleted_at", deleted), ("sent_at", sent_at)):
        if val is not None:
            sets.append(f"{col}=?")
            args.append(val)
    con.execute(f"UPDATE reports SET {', '.join(sets)} WHERE id=?", (*args, rid))
    return con.execute("SELECT version FROM reports WHERE id=?", (rid,)).fetchone()["version"]


def log_event(con, rid, action, detail="", merge=False):
    """History line. With merge=True, repeated edits by the same person within 10 minutes become one line."""
    ts = now_iso()
    if merge:
        last = con.execute("SELECT * FROM events WHERE report_id=? ORDER BY id DESC LIMIT 1", (rid,)).fetchone()
        if last and last["action"] == action and last["client_id"] == g.client_id:
            age = (datetime.fromisoformat(ts) - datetime.fromisoformat(last["ts"])).total_seconds()
            if age < 600:
                have = [x for x in last["detail"].split(", ") if x]
                new = have + [x for x in detail.split(", ") if x and x not in have]
                con.execute("UPDATE events SET ts=?, detail=? WHERE id=?", (ts, ", ".join(new), last["id"]))
                return
    con.execute("INSERT INTO events(report_id,ts,client_id,who,action,detail) VALUES(?,?,?,?,?,?)",
                (rid, ts, g.client_id, g.client_name, action, detail))


def touch_presence(con, rid):
    now = time.time()
    con.execute("INSERT INTO presence(report_id,client_id,name,seen) VALUES(?,?,?,?) "
                "ON CONFLICT(report_id,client_id) DO UPDATE SET name=excluded.name, seen=excluded.seen",
                (rid, g.client_id, g.client_name, now))
    con.execute("DELETE FROM presence WHERE seen < ?", (now - 3600,))


def others_here(con, rid):
    rows = con.execute("SELECT name FROM presence WHERE report_id=? AND client_id!=? AND seen>?",
                       (rid, g.client_id, time.time() - PRESENCE_SECONDS)).fetchall()
    names = []
    for r in rows:
        if r["name"] not in names:
            names.append(r["name"])
    return names


def summary_rows(rc):
    size = core.effective_size(rc)
    space = f"{rc['plant_l']} × {rc['plant_w']} ft" if rc["plant_l"] and rc["plant_w"] else "—"
    return [["CUSTOMER", core.dash(rc["customer"])], ["VISIT", core.fmt_date(rc["visit_date"])],
            ["SITE", f"{core.dash(rc['site_type'])}, {core.dash(rc['served'])} served/day" if rc["site_type"] else "—"],
            ["MEALS PER DAY", core.dash(rc["meals"])],
            ["WASTE PER DAY", f"{rc['waste_kg']} kg" if rc["waste_kg"] else "—"],
            ["SPACE", space],
            ["KITCHEN DISTANCE", f"{rc['dist']} m" if rc["dist"] else "—"],
            ["RECOMMENDED", core.dash(size)], ["PHOTOS", str(len(rc["photos"]))],
            ["FOLLOW-UP", core.followup_line(rc).replace(" – ", ", ")]]


def lead_rows(rc):
    size = core.effective_size(rc)
    kg, cap = core.num(rc["waste_kg"]), core.size_cap(size)
    people = "; ".join(", ".join(x for x in (p["name"], p["designation"], p["contact"]) if x)
                       for p in rc["people"] if p["name"]) or "—"
    wp = "; ".join(x for x in (
        f"{rc['nonveg']} non-veg" if rc["nonveg"] else "",
        ", ".join(rc["includes"]).lower() if rc["includes"] else "",
        f"segregated: {rc['segregated'].lower()}" if rc["segregated"] else "") if x) or "—"
    space = f"{rc['plant_l']} × {rc['plant_w']} ft" if rc["plant_l"] and rc["plant_w"] else "—"
    return [["CUSTOMER", core.dash(rc["customer"])], ["REPORT NO.", core.dash(rc["report_no"])],
            ["VISIT", core.fmt_date(rc["visit_date"])], ["ADDRESS", core.dash(rc["address"])],
            ["WASTE PER DAY", f"{rc['waste_kg']} kg" if rc["waste_kg"] else "—"],
            ["MEALS PER DAY", core.dash(rc["meals"])],
            ["SITE", f"{rc['site_type']}, {core.dash(rc['served'])} served/day" if rc["site_type"] else "—"],
            ["WASTE PROFILE", wp],
            ["UTILISATION", f"{round(kg / cap * 100)}% of {size}" if kg and cap else "—"],
            ["PLANT SPACE", space],
            ["KITCHEN DISTANCE", f"{rc['dist']} m" if rc["dist"] else "—"], ["RECOMMENDED", core.dash(size)],
            ["ISSUES", ", ".join(rc["issues"]) or "—"],
            ["FOLLOW-UP", core.followup_line(rc).replace(" – ", ", ")],
            ["PEOPLE", people], ["PREPARED BY", core.dash(rc["prepared_by"])], ["PHOTOS", str(len(rc["photos"]))]]


def summary_out(row):
    r = row_to_report(row)
    rc = core_view(r)
    return {"id": row["id"], "status": row["status"], "lead_status": row["lead_status"], "version": row["version"],
            "updated": row["updated"], "updated_by": row["updated_by"], "author": row["author"],
            "customer": r["customer"], "report_no": r["report_no"], "visit_date": r["visit_date"],
            "waste_kg": r["waste_kg"], "size": core.effective_size(rc), "missing_count": len(core.missing(rc)),
            "email_status": row["email_status"], "sent_at": row["sent_at"], "deleted": bool(row["deleted_at"]),
            "photo_count": len(r["photos"])}


def report_out(con, row):
    r = row_to_report(row)
    rc = core_view(r)
    miss = core.missing(rc)
    out = {k: r[k] for k in r if k not in ("photos", "prepared_sig")}
    out.update(summary_out(row))
    out["photos"] = [{"file": p["file"], "caption": p.get("caption", ""), "tag": p.get("tag", "")} for p in r["photos"]]
    out["prepared_sig"] = r["prepared_sig"]
    out["missing"] = [[lab, st] for lab, st in miss]
    out["recommendation"] = core.rec_paragraphs(rc)
    out["followup_open"] = core.followup_open(rc)
    out["summary_rows"] = summary_rows(rc)
    out["lead_rows"] = lead_rows(rc)
    out["can_edit"] = row["status"] == "draft" and not row["deleted_at"]
    out["editors"] = others_here(con, row["id"])
    out["history"] = [{"ts": e["ts"], "who": e["who"], "action": e["action"], "detail": e["detail"]}
                      for e in con.execute("SELECT * FROM events WHERE report_id=? ORDER BY id DESC LIMIT 40",
                                           (row["id"],))]
    return out


def need_editable(row):
    if row["deleted_at"]:
        abort(409, "This report is in the trash. Restore it to edit.")
    if row["status"] == "sent":
        abort(409, "This report has been sent. Reopen it to make changes.")


# ------------------------------------------------------------------ meta
@app.get("/api/health")
def health():
    db().execute("SELECT 1")
    return jsonify(ok=True, key_required=bool(ACCESS_KEY))


@app.get("/api/meta")
def meta():
    return jsonify(meta={
        "site_types": core.SITE_TYPES, "op_days": core.OP_DAYS, "issues": core.ISSUES, "nonveg": core.NONVEG,
        "includes": core.INCLUDES, "segregated": core.SEGREGATED, "plant_sizes": core.PLANT_SIZES,
        "followup": core.FOLLOWUP, "lead_status": core.LEAD_STATUS, "photo_tags": core.PHOTO_TAGS,
        "steps": core.STEPS, "waste_how_label": core.WASTE_HOW_LABEL, "step_req_msg": core.STEP_REQ_MSG,
        "rec_p1": core.REC_P1, "rec_p2": core.REC_P2, "org": core.ORG_NAME,
        "email_enabled": email_configured(), "default_recipients": default_recipients(),
        "allowed_email_domains": ALLOWED_EMAIL_DOMAINS})


# ------------------------------------------------------------------ reports
@app.get("/api/reports")
def list_reports():
    tab = request.args.get("tab", "drafts")
    q = request.args.get("q", "").strip().lower()
    if tab == "trash":
        rows = db().execute("SELECT * FROM reports WHERE deleted_at != '' ORDER BY deleted_at DESC").fetchall()
    elif tab == "sent":
        rows = db().execute("SELECT * FROM reports WHERE deleted_at='' AND status='sent' "
                            "ORDER BY sent_at DESC, updated DESC").fetchall()
    elif tab == "all":
        rows = db().execute("SELECT * FROM reports WHERE deleted_at='' ORDER BY updated DESC").fetchall()
    else:
        rows = db().execute("SELECT * FROM reports WHERE deleted_at='' AND status='draft' "
                            "ORDER BY updated DESC").fetchall()
    if q:
        rows = [r for r in rows if q in r["customer"].lower() or q in r["report_no"].lower() or q in r["author"].lower()]
    return jsonify(reports=[summary_out(r) for r in rows])


@app.post("/api/reports")
def create_report():
    today = datetime.now(TZ).date()
    fy = core.fy_label(today)
    rid = uuid.uuid4().hex
    with tx() as con:
        n = (con.execute("SELECT n FROM counters WHERE fy=?", (fy,)).fetchone() or [0])[0]
        while True:
            n += 1
            no = f"Avris/CHUGG/S.A/{n:03d}/{fy}"
            if not con.execute("SELECT 1 FROM reports WHERE report_no=?", (no,)).fetchone():
                break
        con.execute("INSERT INTO counters(fy,n) VALUES(?,?) ON CONFLICT(fy) DO UPDATE SET n=excluded.n", (fy, n))
        r = core.new_report(n - 1)
        r.update(report_no=no, visit_date=today.strftime("%d/%m/%Y"),
                 prepared_by="" if g.client_name == "Someone" else g.client_name)
        data = {k: v for k, v in r.items() if k not in META_KEYS}
        ts = now_iso()
        con.execute("INSERT INTO reports(id,status,lead_status,version,report_no,customer,visit_date,author,data,"
                    "created,updated,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (rid, "draft", "New", 1, no, "", r["visit_date"], g.client_name,
                     json.dumps(data, ensure_ascii=False), ts, ts, g.client_name))
        log_event(con, rid, "created")
    return jsonify(report=report_out(db(), get_row(db(), rid))), 201


@app.get("/api/reports/<rid>")
def get_report(rid):
    row = get_row(db(), rid)
    touch_presence(db(), rid)
    return jsonify(report=report_out(db(), row))


@app.get("/api/reports/<rid>/sync")
def sync(rid):
    """Cheap poll: has anything changed since version v, and who else is here."""
    row = get_row(db(), rid)
    touch_presence(db(), rid)
    try:
        v = int(request.args.get("v", "0"))
    except ValueError:
        v = 0
    return jsonify(version=row["version"], changed=row["version"] != v, status=row["status"],
                   deleted=bool(row["deleted_at"]), updated_by=row["updated_by"], editors=others_here(db(), rid))


@app.put("/api/reports/<rid>")
def put_report(rid):
    b = request.get_json(silent=True)
    if not isinstance(b, dict) or not isinstance(b.get("fields", {}), dict):
        abort(400, "Expected JSON.")
    base = b.get("base_version")
    with tx() as con:
        row = get_row(con, rid)
        need_editable(row)
        r = row_to_report(row)
        changed = []
        for k, v in b["fields"].items():
            if k not in EDITABLE:
                raise BadInput(f"unknown field: {k}")
            nv = clean_field(k, v)
            if r[k] != nv:
                r[k] = nv
                changed.append(k)
        stale = isinstance(base, int) and base != row["version"]
        version = row["version"]
        if changed:
            version = save_data(con, rid, r)
            log_event(con, rid, "edited", ", ".join(changed), merge=True)
        touch_presence(con, rid)
        rc = core_view(r)
        return jsonify(ok=True, version=version, stale=stale, missing_count=len(core.missing(rc)),
                       size=core.effective_size(rc), editors=others_here(con, rid))


@app.delete("/api/reports/<rid>")
def delete_report(rid):
    with tx() as con:
        row = get_row(con, rid)
        if row["deleted_at"]:
            return jsonify(ok=True)
        save_data(con, rid, row_to_report(row), deleted=now_iso())
        log_event(con, rid, "moved to trash")
    return jsonify(ok=True)


@app.post("/api/reports/<rid>/restore")
def restore_report(rid):
    with tx() as con:
        row = get_row(con, rid)
        save_data(con, rid, row_to_report(row), deleted="")
        log_event(con, rid, "restored from trash")
    return jsonify(ok=True)


@app.post("/api/reports/<rid>/reopen")
def reopen_report(rid):
    with tx() as con:
        row = get_row(con, rid)
        if row["deleted_at"]:
            abort(409, "Restore this report from the trash first.")
        if row["status"] != "sent":
            return jsonify(report=report_out(con, row))
        save_data(con, rid, row_to_report(row), status="draft")
        log_event(con, rid, "reopened for editing")
        row = get_row(con, rid)
        return jsonify(report=report_out(con, row))


@app.put("/api/reports/<rid>/lead")
def set_lead(rid):
    status = str((request.get_json(silent=True) or {}).get("lead_status", ""))
    if status not in core.LEAD_STATUS:
        abort(400, "Unknown lead status.")
    with tx() as con:
        row = get_row(con, rid)
        if row["status"] != "sent":
            abort(409, "Only sent reports are leads.")
        if row["lead_status"] != status:
            save_data(con, rid, row_to_report(row), lead=status)
            log_event(con, rid, "lead status", status)
    return jsonify(ok=True, lead_status=status)


# ------------------------------------------------------------------ photos
def sniff_image(data):
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"GIF8":
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def store_photo(data):
    kind = sniff_image(data)
    if kind is None:
        raise BadInput("That file is not a supported image (JPEG, PNG, GIF or WebP).")
    name = uuid.uuid4().hex
    if Image is not None:
        try:
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
            im.thumbnail((1600, 1600))
            fname = name + ".jpg"
            im.save(PHOTO_DIR / fname, "JPEG", quality=85)
            return fname
        except Exception:
            raise BadInput("That image could not be read.")
    if kind not in ("jpg", "png"):
        raise BadInput("Only JPEG and PNG photos are supported on this server.")
    fname = f"{name}.{kind}"
    (PHOTO_DIR / fname).write_bytes(data)
    return fname


@app.post("/api/reports/<rid>/photos")
def add_photos(rid):
    files = request.files.getlist("photos")
    if not files:
        abort(400, "No photos received.")
    blobs = [f.read() for f in files]
    added = []
    try:
        with tx() as con:
            row = get_row(con, rid)
            need_editable(row)
            r = row_to_report(row)
            if len(r["photos"]) + len(blobs) > MAX_PHOTOS:
                abort(400, f"A report can hold up to {MAX_PHOTOS} photos.")
            for data in blobs:
                fname = store_photo(data)
                added.append(fname)
                r["photos"].append({"file": fname, "caption": "", "tag": ""})
            save_data(con, rid, r)
            log_event(con, rid, "photo added", f"{len(blobs)}", merge=False)
    except BaseException:
        for fname in added:
            try:
                (PHOTO_DIR / fname).unlink()
            except OSError:
                pass
        raise
    return jsonify(report=report_out(db(), get_row(db(), rid)))


@app.put("/api/reports/<rid>/photos/<fname>")
def edit_photo(rid, fname):
    b = request.get_json(silent=True) or {}
    with tx() as con:
        row = get_row(con, rid)
        need_editable(row)
        r = row_to_report(row)
        ph = next((p for p in r["photos"] if p["file"] == fname), None)
        if ph is None:
            abort(404)
        if "caption" in b:
            ph["caption"] = clean_str(b["caption"], 300)
        if "tag" in b:
            tag = clean_str(b["tag"], 40)
            if tag and tag not in core.PHOTO_TAGS:
                raise BadInput("invalid tag")
            ph["tag"] = tag
        version = save_data(con, rid, r)
        log_event(con, rid, "edited", "photo caption", merge=True)
    return jsonify(ok=True, version=version)


@app.delete("/api/reports/<rid>/photos/<fname>")
def remove_photo(rid, fname):
    with tx() as con:
        row = get_row(con, rid)
        need_editable(row)
        r = row_to_report(row)
        if not any(p["file"] == fname for p in r["photos"]):
            abort(404)
        r["photos"] = [p for p in r["photos"] if p["file"] != fname]
        save_data(con, rid, r)
        log_event(con, rid, "photo removed")
    try:
        (PHOTO_DIR / fname).unlink()
    except OSError:
        pass
    return jsonify(ok=True)


@app.get("/api/reports/<rid>/photos/<fname>")
def get_photo(rid, fname):
    r = row_to_report(get_row(db(), rid))
    if not any(p["file"] == fname for p in r["photos"]):
        abort(404)
    path = PHOTO_DIR / fname
    if not path.is_file():
        abort(404)
    return send_file(path, max_age=3600)


# ------------------------------------------------------------------ preview and downloads
@app.get("/api/logo/<key>")
def logo(key):
    if key not in ("avris", "chugg"):
        abort(404)
    resp = Response(core.logo_png(key, "s122"), mimetype="image/png")
    resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


@app.get("/api/reports/<rid>/layout")
def layout(rid):
    r = row_to_report(get_row(db(), rid))
    rc = core_view(r)
    files = {str(PHOTO_DIR / p["file"]): p["file"] for p in r["photos"]}
    pages = []
    for prims in core.layout_report(rc):
        out = []
        for p in prims:
            if p[0] == "photo":
                out.append(["photo", *p[1:5], files.get(p[5])])
            elif p[0] == "sig":
                _, x, y, w, h, strokes = p
                out.append(["sig", [[list(pt) for pt in st] for st in core.sig_points(strokes, x, y, w, h)]])
            else:
                out.append(list(p))
        pages.append(out)
    return jsonify(pw=core.PW, ph=core.PH, pages=pages)


EXPORTS = {"pdf": (core.export_pdf, "application/pdf"),
           "docx": (core.export_docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
           "csv": (core.export_csv, "text/csv; charset=utf-8")}


def render_export(rc, kind):
    fn, _ = EXPORTS[kind]
    with tempfile.TemporaryDirectory() as d:
        path = Path(d) / f"report.{kind}"
        fn(rc, path)
        return path.read_bytes()


def attachment(data, mimetype, filename):
    resp = Response(data, mimetype=mimetype)
    resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


@app.get("/api/reports/<rid>/export/<kind>")
def export(rid, kind):
    if kind not in EXPORTS:
        abort(404)
    rc = core_view(row_to_report(get_row(db(), rid)))
    return attachment(render_export(rc, kind), EXPORTS[kind][1], f"{core.safe_name(rc)}.{kind}")


def _bulk_rows():
    tab = request.args.get("tab", "sent")
    where = {"sent": "deleted_at='' AND status='sent'", "drafts": "deleted_at='' AND status='draft'",
             "all": "deleted_at=''"}.get(tab, "deleted_at='' AND status='sent'")
    return db().execute(f"SELECT * FROM reports WHERE {where} ORDER BY report_no").fetchall()


BULK_COLS = ["Report no.", "Customer", "Visit date", "Status", "Lead status", "Author", "Address", "Site type",
             "People served/day", "Waste per day (kg)", "Meals per day", "Recommended plant", "Plant space (ft)",
             "Distance to kitchen (m)", "Follow-up", "Contact", "Prepared by", "Sent at (UTC)", "Email status",
             "Last updated (UTC)", "Last updated by"]


def bulk_line(row):
    r = row_to_report(row)
    rc = core_view(r)
    p = r["people"][0] if r["people"] else {}
    contact = ", ".join(x for x in (p.get("name", ""), p.get("designation", ""), p.get("contact", ""),
                                    p.get("email", "")) if x)
    return [r["report_no"], r["customer"], r["visit_date"], row["status"], row["lead_status"] if row["status"] == "sent" else "",
            row["author"], r["address"].replace("\n", " "), r["site_type"], r["served"], r["waste_kg"], r["meals"],
            core.effective_size(rc), f"{r['plant_l']} x {r['plant_w']}" if r["plant_l"] and r["plant_w"] else "",
            r["dist"], core.followup_line(rc).replace(" – ", ", "), contact, r["prepared_by"], row["sent_at"],
            row["email_status"], row["updated"], row["updated_by"]]


@app.get("/api/export/all.csv")
def export_all_csv():
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(BULK_COLS)
    for row in _bulk_rows():
        w.writerow(bulk_line(row))
    return attachment(("﻿" + buf.getvalue()).encode("utf-8"), "text/csv; charset=utf-8",
                      f"avris_reports_{datetime.now(TZ).strftime('%Y%m%d')}.csv")


@app.get("/api/export/all.zip")
def export_all_zip():
    rows = _bulk_rows()[:300]
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        idx = io.StringIO()
        w = csv.writer(idx)
        w.writerow(BULK_COLS)
        for row in rows:
            rc = core_view(row_to_report(row))
            w.writerow(bulk_line(row))
            z.writestr(f"{core.safe_name(rc)}.pdf", render_export(rc, "pdf"))
        z.writestr("index.csv", "﻿" + idx.getvalue())
    return attachment(out.getvalue(), "application/zip", f"avris_reports_{datetime.now(TZ).strftime('%Y%m%d')}.zip")


# ------------------------------------------------------------------ email
def email_configured():
    return bool(os.environ.get("SMTP_HOST"))


def default_recipients():
    return [e.strip() for e in os.environ.get("SALES_EMAILS", "").split(",") if e.strip()]


EMAIL_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")
_mail_times = deque()
_mail_lock = threading.Lock()


def check_recipients(to):
    if not isinstance(to, list):
        raise BadInput("Enter at least one email address.")
    out = []
    for e in to:
        e = clean_str(str(e), 200).strip()
        if not e:
            continue
        if not EMAIL_RE.match(e):
            raise BadInput(f"'{e}' is not a valid email address.")
        if ALLOWED_EMAIL_DOMAINS and e.lower().rsplit("@", 1)[1] not in ALLOWED_EMAIL_DOMAINS:
            raise BadInput(f"Emails can only go to: {', '.join('@' + d for d in ALLOWED_EMAIL_DOMAINS)}.")
        if e.lower() not in [x.lower() for x in out]:
            out.append(e)
    if not out:
        raise BadInput("Enter at least one email address.")
    if len(out) > 10:
        raise BadInput("You can email up to 10 people at once.")
    return out


def mail_budget():
    """Hourly cap so an open link cannot be used to spam."""
    now = time.time()
    with _mail_lock:
        while _mail_times and now - _mail_times[0] > 3600:
            _mail_times.popleft()
        if len(_mail_times) >= int(os.environ.get("MAIL_PER_HOUR", "60")):
            return False
        _mail_times.append(now)
        return True


def send_smtp(msg):
    host = os.environ["SMTP_HOST"]
    ssl_mode = os.environ.get("SMTP_SSL", "0") == "1"
    port = int(os.environ.get("SMTP_PORT") or (465 if ssl_mode else 587))
    ctx = ssl.create_default_context()
    if ssl_mode:
        s = smtplib.SMTP_SSL(host, port, timeout=25, context=ctx)
    else:
        s = smtplib.SMTP(host, port, timeout=25)
        if os.environ.get("SMTP_STARTTLS", "1") != "0":
            s.starttls(context=ctx)
    with s:
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)


def build_email(row, to, who, note="", updated=False):
    r = row_to_report(row)
    rc = core_view(r)
    size = core.effective_size(rc)
    draft = row["status"] != "sent"
    msg = EmailMessage()
    tag = "[Draft] " if draft else "[Updated] " if updated else ""
    msg["Subject"] = f"{tag}Site visit report: {rc['customer'] or 'Untitled'} ({rc['report_no']})"
    msg["From"] = os.environ.get("MAIL_FROM") or os.environ.get("SMTP_USER") or "avris-reports@localhost"
    msg["To"] = ", ".join(to)
    if os.environ.get("REPLY_TO"):
        msg["Reply-To"] = os.environ["REPLY_TO"]
    lines = [f"{who} shared a CHUGG site visit report with you.", ""]
    if note:
        lines += [note, ""]
    lines += [f"Customer: {rc['customer'] or '-'}", f"Report no.: {rc['report_no']}",
              f"Visit date: {core.fmt_date(rc['visit_date'])}",
              f"Site: {rc['site_type'] or '-'}, {rc['served'] or '-'} people served per day",
              f"Waste per day: {rc['waste_kg'] + ' kg' if rc['waste_kg'] else '-'}",
              f"Recommended plant: {size or '-'}",
              f"Follow-up: {core.followup_line(rc).replace(' – ', ', ')}", "",
              "The full report is attached as a PDF."]
    if draft:
        lines += ["This report is still a draft and may be incomplete."]
    base = os.environ.get("BASE_URL", "").rstrip("/")
    if base:
        lines += ["", f"Open in the app: {base}/#/lead/{row['id']}"]
    msg.set_content("\n".join(lines))
    msg.add_attachment(render_export(rc, "pdf"), maintype="application", subtype="pdf",
                       filename=f"{core.safe_name(rc)}.pdf")
    return msg


def deliver(rid, to, who, note="", client_id="", record_default=False, updated=False):
    """Build and send the PDF email. Returns (ok, message). Records the result in the report history."""
    con = open_db()
    try:
        row = con.execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
        if row is None:
            return False, "Report not found."
        try:
            send_smtp(build_email(row, to, who, note, updated))
            ok, text = True, "sent to " + ", ".join(to)
        except Exception as e:  # noqa: BLE001 - shown to the user, full detail in the log
            log.exception("Email for report %s failed", rid)
            ok, text = False, f"failed: {str(e)[:160]}"
        with tx(con):
            if record_default:
                con.execute("UPDATE reports SET email_status=?, email_at=?, version=version+1 WHERE id=?",
                            (text, now_iso(), rid))
            else:
                con.execute("UPDATE reports SET version=version+1 WHERE id=?", (rid,))   # peers refresh history
            con.execute("INSERT INTO events(report_id,ts,client_id,who,action,detail) VALUES(?,?,?,?,?,?)",
                        (rid, now_iso(), client_id, who, "emailed" if ok else "email failed", text))
        return ok, text
    finally:
        con.close()


@app.post("/api/reports/<rid>/send")
def send_report(rid):
    with tx() as con:
        row = get_row(con, rid)
        need_editable(row)
        r = row_to_report(row)
        rc = core_view(r)
        miss = core.missing(rc)
        if miss:
            return jsonify(error="The report is not complete yet.", missing=[[a, b] for a, b in miss]), 400
        if not r["plant_size"]:
            r["plant_size"] = core.effective_size(rc)
        to = default_recipients()
        if not email_configured():
            est = "not emailed: the server has no email account set up"
        elif not to:
            est = "not emailed: no default recipients are set"
        else:
            est = "queued"
        first_send = not row["sent_at"]
        save_data(con, rid, r, status="sent", lead="New" if first_send else None, email_status=est,
                  sent_at=now_iso())
        log_event(con, rid, "sent to sales" if first_send else "re-sent to sales")
        row = get_row(con, rid)
        out = report_out(con, row)
    if est == "queued":
        if mail_budget():
            threading.Thread(target=deliver, args=(rid, to, g.client_name, "", g.client_id, True, not first_send),
                             daemon=True).start()
        else:
            db().execute("UPDATE reports SET email_status='not emailed: hourly email limit reached' WHERE id=?", (rid,))
    return jsonify(report=out)


@app.post("/api/reports/<rid>/email")
def email_report(rid):
    """Email the PDF to chosen people (or to the default sales list when no addresses are given)."""
    b = request.get_json(silent=True) or {}
    row = get_row(db(), rid)
    if not email_configured():
        abort(409, "Email is not set up on the server. Use Share or Download instead.")
    use_default = not b.get("to")
    to = default_recipients() if use_default else check_recipients(b.get("to"))
    if not to:
        abort(400, "No recipients. Enter an email address.")
    if not mail_budget():
        abort(429, "Hourly email limit reached. Try again later.")
    note = clean_str(str(b.get("note", "")), 1000).strip()
    ok, text = deliver(rid, to, g.client_name, note, g.client_id, record_default=use_default and row["status"] == "sent")
    if not ok:
        return jsonify(error="The email could not be sent. " + text), 502
    return jsonify(ok=True, status=text)


# ------------------------------------------------------------------ frontend (local use and fallback)
@app.get("/")
def index():
    resp = send_from_directory(STATIC_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/<path:name>")
def static_files(name):
    if name.startswith("api/"):
        abort(404)
    resp = send_from_directory(STATIC_DIR, name)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


init_db()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)

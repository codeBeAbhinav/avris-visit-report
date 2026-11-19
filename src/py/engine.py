"""Browser-side report engine.

Runs inside Pyodide (Python in WebAssembly) and reuses avris_core.py unchanged, so the preview, PDF,
Word and CSV output are exactly what the desktop tool produced. Everything here takes and returns
JSON text (or bytes for files). Photos are written by the page into /photos/<file> before an export.
"""
import copy
import csv
import io
import json
import re
import zipfile
from datetime import date, datetime

import avris_core as core

core.PHOTO_DIR = core.Path("/photos")
PHOTO_DIR = core.PHOTO_DIR

TEMPLATE = core.new_report(0)
META_KEYS = ("id", "status", "lead_status", "step", "updated")
EDITABLE = [k for k in TEMPLATE if k not in META_KEYS + ("photos",)]
CHOICE_FIELDS = {"site_type": core.SITE_TYPES, "op_days": core.OP_DAYS, "nonveg": core.NONVEG,
                 "segregated": core.SEGREGATED, "plant_size": core.PLANT_SIZES, "followup": core.FOLLOWUP}
MULTI_FIELDS = {"issues": core.ISSUES, "includes": core.INCLUDES, "peak_days": core.PEAK_DAYS,
                "examples": list(core.EXAMPLES)}
SIG_IMG_MAX = 700_000   # characters of the data: URL (about 500 KB of PNG)
CLEAN_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class BadInput(Exception):
    pass


def clean_str(v, cap=4000):
    if not isinstance(v, str):
        raise BadInput("expected text")
    return CLEAN_RE.sub("", v)[:cap]


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
    if key == "prepared_sig_img":
        v = clean_str(v, SIG_IMG_MAX + 1) if isinstance(v, str) else ""
        if len(v) > SIG_IMG_MAX:
            raise BadInput("That signature image is too large.")
        if v and not core.sig_img_bytes(v):
            raise BadInput("That signature image could not be read.")
        return v
    return clean_str(v, 4000)


# ------------------------------------------------------------------ report model
def full(data):
    """A stored report with any newer template fields filled in."""
    r = dict(data)
    for k, v in TEMPLATE.items():
        r.setdefault(k, copy.deepcopy(v))
    return r


def core_view(r, photos):
    c = dict(r)
    c["photos"] = [{"path": str(PHOTO_DIR / p["file"]), "caption": p.get("caption", ""), "tag": p.get("tag", ""),
                    "fit": p.get("fit") if p.get("fit") in core.PHOTO_FITS else "fill"} for p in photos]
    return c


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


# ------------------------------------------------------------------ calls from the page (JSON in, JSON out)
def meta():
    return json.dumps({
        "site_types": core.SITE_TYPES, "op_days": core.OP_DAYS, "issues": core.ISSUES, "nonveg": core.NONVEG,
        "includes": core.INCLUDES, "segregated": core.SEGREGATED, "plant_sizes": core.PLANT_SIZES,
        "followup": core.FOLLOWUP, "lead_status": core.LEAD_STATUS, "photo_tags": core.PHOTO_TAGS,
        "steps": core.STEPS, "waste_how_label": core.WASTE_HOW_LABEL, "step_req_msg": core.STEP_REQ_MSG,
        "rec_p1": core.REC_P1, "rec_p2": core.REC_P2, "org": core.ORG_NAME, "peak_days": core.PEAK_DAYS,
        "examples": {k: [v, label, st] for k, (v, label, st) in core.EXAMPLES.items()},
        "sig_box": [core.SIG_W, core.SIG_H], "photo_box": [core.PHOTO_W, core.BOXH]})


def blank(n, prepared_by):
    """A new report. n is the running number within the financial year (1, 2, 3...)."""
    today = date.today()
    fy = core.fy_label(today)
    r = core.new_report(n - 1)
    r.update(report_no=f"Avris/CHUGG/S.A/{n:03d}/{fy}", visit_date=today.strftime("%d/%m/%Y"),
             prepared_by=core.cap_words(prepared_by))
    for k, (v, _, _) in core.EXAMPLES.items():   # example amounts, each flagged until changed or confirmed
        r[k] = v
    r["examples"] = list(core.EXAMPLES)
    data = {k: v for k, v in r.items() if k not in META_KEYS}
    return json.dumps({"fy": fy, "data": data})


def apply_fields(data_json, fields_json):
    r = full(json.loads(data_json))
    changed = []
    fields = json.loads(fields_json)
    for k, v in fields.items():
        if k not in EDITABLE:
            raise BadInput(f"unknown field: {k}")
        nv = clean_field(k, v)
        if r[k] != nv:
            r[k] = nv
            changed.append(k)
    # an example amount stops being an example once someone types over it
    if "examples" not in fields:
        left = [k for k in r["examples"] if k not in changed]
        if left != r["examples"]:
            r["examples"] = left
            changed.append("examples")
    return json.dumps({"data": r, "changed": changed})


def tidy(data_json):
    """Capitalisation rules applied when a report is generated."""
    r = full(json.loads(data_json))
    changed = core.tidy_caps(r)
    return json.dumps({"data": r, "changed": changed})


def derive(data_json, photos_json):
    """Everything the screens show that is computed from the report."""
    r = full(json.loads(data_json))
    rc = core_view(r, json.loads(photos_json))
    miss = core.missing(rc)
    return json.dumps({
        "size": core.effective_size(rc), "missing_count": len(miss), "missing": [[a, b] for a, b in miss],
        "recommendation": core.rec_paragraphs(rc), "followup_open": core.followup_open(rc),
        "summary_rows": summary_rows(rc), "lead_rows": lead_rows(rc), "email_subject": email_subject(rc)})


def layout(data_json, photos_json):
    r = full(json.loads(data_json))
    photos = json.loads(photos_json)
    rc = core_view(r, photos)
    files = {str(PHOTO_DIR / p["file"]): p["file"] for p in photos}
    pages = []
    for prims in core.layout_report(rc):
        out = []
        for p in prims:
            if p[0] == "photo":
                out.append(["photo", *p[1:5], files.get(p[5]), p[6] if len(p) > 6 else "fill"])
            elif p[0] == "sigimg":
                out.append(["sigimg", *p[1:5]])     # the page draws R.prepared_sig_img into this box
            elif p[0] == "sig":
                _, x, y, w, h, strokes = p
                out.append(["sig", [[list(pt) for pt in st] for st in core.sig_points(strokes, x, y, w, h)]])
            else:
                out.append(list(p))
        pages.append(out)
    return json.dumps({"pw": core.PW, "ph": core.PH, "pages": pages})


def safe_name(data_json):
    return core.safe_name(full(json.loads(data_json)))


def logo(key):
    return core.logo_png(key, "s122")


def _render(rc, kind):
    fn = {"pdf": core.export_pdf, "docx": core.export_docx, "csv": core.export_csv}[kind]
    path = core.Path(f"/tmp/report.{kind}")
    fn(rc, path)
    try:
        return path.read_bytes()
    finally:
        path.unlink()


def export(data_json, photos_json, kind):
    r = full(json.loads(data_json))
    return _render(core_view(r, json.loads(photos_json)), kind)


def cloud_row(item_json):
    """One register row for Google Sheets. Column names match the Reports sheet in cloud/Code.gs."""
    item = json.loads(item_json)
    r = full(item["data"])
    rc = core_view(r, item["photos"])
    people = [p for p in r["people"] if p.get("name") or p.get("contact") or p.get("email")]
    first = people[0] if people else {}
    contact = "; ".join((f"{p['name']} ({p['designation']})" if p.get("designation") else p["name"]) for p in people if p.get("name"))
    space = f"{r['plant_l']} x {r['plant_w']}" if r["plant_l"] and r["plant_w"] else ""
    return json.dumps({
        "Customer": r["customer"], "Visit date": r["visit_date"], "Address": r["address"].replace("\n", ", "),
        "Site type": r["site_type"], "Contact": contact, "Phone": first.get("contact", ""), "Email": first.get("email", ""),
        "People served/day": r["served"], "Meals per day": r["meals"], "Waste per day (kg)": r["waste_kg"],
        "Recommended plant": core.effective_size(rc), "Plant space (ft)": space, "Distance to kitchen (m)": r["dist"],
        "Follow-up": core.followup_line(rc).replace(" \u2013 ", ", "), "Prepared by": r["prepared_by"],
        "Lead status": item.get("lead_status", "") if item.get("status") == "sent" else "", "Photos": len(item["photos"])})


BULK_COLS = ["Report no.", "Customer", "Visit date", "Status", "Lead status", "Address", "Site type",
             "People served/day", "Waste per day (kg)", "Meals per day", "Recommended plant", "Plant space (ft)",
             "Distance to kitchen (m)", "Follow-up", "Contact", "Prepared by", "Completed at (UTC)",
             "Last updated (UTC)", "Last updated by"]


def _bulk_line(item):
    r = full(item["data"])
    rc = core_view(r, item["photos"])
    p = r["people"][0] if r["people"] else {}
    contact = ", ".join(x for x in (p.get("name", ""), p.get("designation", ""), p.get("contact", ""),
                                    p.get("email", "")) if x)
    done = item["status"] == "sent"
    return [r["report_no"], r["customer"], r["visit_date"], "completed" if done else "in progress",
            item["lead_status"] if done else "", r["address"].replace("\n", " "), r["site_type"], r["served"],
            r["waste_kg"], r["meals"], core.effective_size(rc),
            f"{r['plant_l']} x {r['plant_w']}" if r["plant_l"] and r["plant_w"] else "", r["dist"],
            core.followup_line(rc).replace(" – ", ", "), contact, r["prepared_by"], item.get("sent_at", ""),
            item.get("updated", ""), item.get("updated_by", "")]


def bulk(items_json, kind):
    items = json.loads(items_json)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(BULK_COLS)
    for it in items:
        w.writerow(_bulk_line(it))
    text = "﻿" + buf.getvalue()
    if kind == "csv":
        return text.encode("utf-8")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for it in items:
            rc = core_view(full(it["data"]), it["photos"])
            z.writestr(f"{core.safe_name(rc)}.pdf", _render(rc, "pdf"))
        z.writestr("index.csv", text)
    return out.getvalue()


def bundle(data_json, photos_json):
    """PDF, Word and CSV for one report in a single ZIP."""
    r = full(json.loads(data_json))
    rc = core_view(r, json.loads(photos_json))
    name = core.safe_name(rc)
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for kind in ("pdf", "docx", "csv"):
            z.writestr(f"{name}.{kind}", _render(rc, kind))
    return out.getvalue()


# ---------------------------------------------------------------- email to the AVRIS team
def _val(v, empty="Not recorded"):
    v = str(v or "").strip()
    return v if v and v not in ("—", "-") else empty


def email_subject(rc):
    cust = _val(rc["customer"], "Untitled site")
    return f"Site visit report | {cust} | {rc['report_no']} | {core.fmt_date(rc['visit_date'])}"


def email_content(data_json, photos_json, extra_json):
    """Pre-built email for the internal team: subject, plain text and HTML. extra: note, sender, folder_url, files."""
    r = full(json.loads(data_json))
    rc = core_view(r, json.loads(photos_json))
    extra = json.loads(extra_json or "{}")
    people = [p for p in r["people"] if p.get("name") or p.get("contact")]
    contact = "; ".join(", ".join(x for x in (p.get("name", ""), p.get("designation", ""), p.get("contact", "")) if x)
                        for p in people)
    waste = f"{r['waste_kg']} kg per day" + (f" ({r['waste_how'].strip()})" if r["waste_how"].strip() else "") \
        if r["waste_kg"] else ""
    space = f"{r['plant_l']} x {r['plant_w']} ft" if r["plant_l"] and r["plant_w"] else ""
    follow = core.followup_line(rc).replace(" – ", ", ").replace("—", "").strip(", ")
    rows = [("Report no.", r["report_no"]), ("Customer", r["customer"]), ("Visit date", core.fmt_date(r["visit_date"])),
            ("Address", r["address"].replace("\n", ", ")), ("Site type", r["site_type"]), ("Contact on site", contact),
            ("Waste generated", waste), ("Meals per day", r["meals"]), ("People served per day", r["served"]),
            ("Recommended plant", core.effective_size(rc)), ("Space available", space),
            ("Distance to kitchen", f"{r['dist']} m" if r["dist"] else ""), ("Follow-up visit", follow),
            ("Prepared by", r["prepared_by"])]
    rows = [(k, _val(v)) for k, v in rows]
    sender = str(extra.get("sender") or r["prepared_by"] or "").strip()
    note = str(extra.get("note") or "").strip()
    folder = str(extra.get("folder_url") or "").strip()
    files = [str(f) for f in extra.get("files") or []]
    cust = _val(r["customer"], "the site")
    intro = (f"Please find attached the site visit report for {cust}, visited on {core.fmt_date(r['visit_date'])}"
             f"{' by ' + r['prepared_by'].strip() if r['prepared_by'].strip() else ''}.")
    width = max(len(k) for k, _ in rows)
    text = ["Dear Team,", "", intro, ""]
    if note:
        text += ["Note from " + (sender or "the sender") + ":", note, ""]
    text += ["Summary"] + [f"{k.ljust(width)}  {v}" for k, v in rows] + [""]
    if files:
        text += ["Attached: " + ", ".join(files) + "."]
    if folder:
        text += ["Google Drive folder: " + folder]
    text += ["", "Regards,", sender or "AVRIS site team", "AVRIS Environment Technologies Pvt Ltd"]
    esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    td = 'style="padding:6px 12px;border-bottom:1px solid #e4e4e7;vertical-align:top;font-size:14px"'
    html = ['<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.5">',
            "<p>Dear Team,</p>", f"<p>{esc(intro)}</p>"]
    if note:
        html.append(f'<p style="border-left:3px solid #5be400;padding:4px 10px;margin:12px 0">'
                    f'<b>Note from {esc(sender or "the sender")}:</b><br>{esc(note).replace(chr(10), "<br>")}</p>')
    html.append('<p style="margin:16px 0 6px"><b>Summary</b></p><table style="border-collapse:collapse">')
    for k, v in rows:
        html.append(f'<tr><td {td}><b>{esc(k)}</b></td><td {td}>{esc(v)}</td></tr>')
    html.append("</table>")
    if files:
        html.append(f"<p>Attached: {esc(', '.join(files))}.</p>")
    if folder:
        html.append(f'<p>Google Drive folder: <a href="{esc(folder)}">{esc(folder)}</a></p>')
    html.append(f"<p>Regards,<br>{esc(sender or 'AVRIS site team')}<br>AVRIS Environment Technologies Pvt Ltd</p></div>")
    return json.dumps({"subject": email_subject(rc), "text": "\n".join(text), "html": "".join(html)})

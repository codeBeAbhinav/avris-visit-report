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
MULTI_FIELDS = {"issues": core.ISSUES, "includes": core.INCLUDES}
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
    c["photos"] = [{"path": str(PHOTO_DIR / p["file"]), "caption": p.get("caption", ""), "tag": p.get("tag", "")}
                   for p in photos]
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
        "rec_p1": core.REC_P1, "rec_p2": core.REC_P2, "org": core.ORG_NAME})


def blank(n, prepared_by):
    """A new report. n is the running number within the financial year (1, 2, 3...)."""
    today = date.today()
    fy = core.fy_label(today)
    r = core.new_report(n - 1)
    r.update(report_no=f"Avris/CHUGG/S.A/{n:03d}/{fy}", visit_date=today.strftime("%d/%m/%Y"), prepared_by=prepared_by)
    data = {k: v for k, v in r.items() if k not in META_KEYS}
    return json.dumps({"fy": fy, "data": data})


def apply_fields(data_json, fields_json):
    r = full(json.loads(data_json))
    changed = []
    for k, v in json.loads(fields_json).items():
        if k not in EDITABLE:
            raise BadInput(f"unknown field: {k}")
        nv = clean_field(k, v)
        if r[k] != nv:
            r[k] = nv
            changed.append(k)
    return json.dumps({"data": r, "changed": changed})


def derive(data_json, photos_json):
    """Everything the screens show that is computed from the report."""
    r = full(json.loads(data_json))
    rc = core_view(r, json.loads(photos_json))
    miss = core.missing(rc)
    return json.dumps({
        "size": core.effective_size(rc), "missing_count": len(miss), "missing": [[a, b] for a, b in miss],
        "recommendation": core.rec_paragraphs(rc), "followup_open": core.followup_open(rc),
        "summary_rows": summary_rows(rc), "lead_rows": lead_rows(rc)})


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
                out.append(["photo", *p[1:5], files.get(p[5])])
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

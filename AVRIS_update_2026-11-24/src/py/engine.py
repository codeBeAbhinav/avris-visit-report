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
FIXED_KEYS = ("photos", "report_type")      # the type is chosen once, when the report is made
EDITABLE = [k for k in TEMPLATE if k not in META_KEYS + FIXED_KEYS]
CHOICE_FIELDS = {"site_type": core.SITE_TYPES, "op_days": core.OP_DAYS, "nonveg": core.NONVEG,
                 "segregated": core.SEGREGATED, "plant_size": core.PLANT_SIZES, "followup": core.FOLLOWUP,
                 "waste_how_pick": core.WASTE_HOW_OPTS, "plant_model": core.PLANT_SIZES,
                 "staff_trained": core.YES_NO, "manual_handed": core.YES_NO, "safety_brief": core.YES_NO,
                 "meter_reset": ["Yes"]}
MULTI_FIELDS = {"issues": core.ISSUES, "includes": core.INCLUDES, "peak_days": core.PEAK_DAYS,
                "examples": list(core.EXAMPLES), "existing_pick": core.EXISTING_OPTS, "route_pick": core.ROUTE_OPTS}
SIG_KEYS, SIG_IMG_KEYS = ("prepared_sig", "cust_sig"), ("prepared_sig_img", "cust_sig_img")
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
    if key in SIG_KEYS:
        return clean_signature(v)
    if key in SIG_IMG_KEYS:
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
    old = "report_type" not in r
    for k, v in TEMPLATE.items():
        r.setdefault(k, copy.deepcopy(v))
    if old:   # made before report types and report dates existed
        r["report_type"] = core.PRE
        if not r.get("report_date"):
            r["report_date"] = r.get("visit_date", "")
    return r


def core_view(r, photos):
    c = dict(r)
    c["photos"] = [{"path": str(PHOTO_DIR / p["file"]), "caption": p.get("caption", ""), "tag": p.get("tag", ""),
                    "fit": p.get("fit") if p.get("fit") in core.PHOTO_FITS else "fill"} for p in photos]
    return c


def _post_rows(rc):
    since, avg = core.hour_calc(rc)
    return [["TYPE", core.POST], ["CUSTOMER", core.dash(rc["customer"])], ["REPORT NO.", core.dash(rc["report_no"])],
            ["VISIT", core.fmt_date(rc["visit_date"])], ["REPORT DATE", core.fmt_date(rc["report_date"])],
            ["PLANT", " · ".join(x for x in (rc["plant_model"], rc["serial_no"]) if x) or "—"],
            ["HOUR METRE", f"{rc['hour_reading']} hrs" if rc["hour_reading"] else "—"],
            ["SINCE LAST READING", f"{since:g} hrs" + (f", {avg:g} hrs/day" if avg is not None else "") if since is not None else "—"],
            ["WASTE PER DAY", f"{rc['waste_kg']} kg" if rc["waste_kg"] else "—"],
            ["TRAINING", ", ".join(f"{k}: {rc[f]}" for k, f in (("Staff", "staff_trained"), ("Manual", "manual_handed"),
                                                                   ("Safety", "safety_brief")) if rc[f]) or "—"],
            ["FOLLOW-UP", core.followup_line(rc).replace(" – ", ", ")],
            ["APPROVED BY", ", ".join(x for x in (rc["cust_name"], rc["cust_designation"]) if x) or "—"],
            ["PREPARED BY", core.dash(rc["prepared_by"])], ["PHOTOS", str(len(rc["photos"]))]]


def summary_rows(rc):
    if core.is_post(rc):
        return _post_rows(rc)
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
    if core.is_post(rc):
        return _post_rows(rc)
    size = core.effective_size(rc)
    kg, cap = core.num(rc["waste_kg"]), core.size_cap(size)
    people = "; ".join(", ".join(x for x in (p["name"], p["designation"], p["contact"]) if x)
                       for p in rc["people"] if p["name"]) or "—"
    wp = "; ".join(x for x in (
        f"{rc['nonveg']} non-veg" if rc["nonveg"] else "",
        ", ".join(rc["includes"]).lower() if rc["includes"] else "",
        f"segregated: {rc['segregated'].lower()}" if rc["segregated"] else "") if x) or "—"
    space = f"{rc['plant_l']} × {rc['plant_w']} ft" if rc["plant_l"] and rc["plant_w"] else "—"
    return [["TYPE", core.PRE], ["CUSTOMER", core.dash(rc["customer"])], ["REPORT NO.", core.dash(rc["report_no"])],
            ["VISIT", core.fmt_date(rc["visit_date"])], ["REPORT DATE", core.fmt_date(rc["report_date"])],
            ["ADDRESS", core.dash(rc["address"])],
            ["WASTE PER DAY", f"{rc['waste_kg']} kg" if rc["waste_kg"] else "—"],
            ["MEALS PER DAY", core.dash(rc["meals"])],
            ["SITE", f"{rc['site_type']}, {core.dash(rc['served'])} served/day" if rc["site_type"] else "—"],
            ["WASTE PROFILE", wp],
            ["UTILISATION", f"{round(kg / cap * 100)}% of {size}" if kg and cap else "—"],
            ["PLANT SPACE", space],
            ["KITCHEN DISTANCE", f"{rc['dist']} m" if rc["dist"] else "—"], ["RECOMMENDED", core.dash(size)],
            ["ISSUES", ", ".join(rc["issues"]) or "—"],
            ["FOLLOW-UP", core.followup_line(rc).replace(" – ", ", ")],
            ["PEOPLE", people], ["PREPARED BY", core.dash(rc["prepared_by"])],
            ["APPROVED BY", ", ".join(x for x in (rc["cust_name"], rc["cust_designation"]) if x) or "—"],
            ["PHOTOS", str(len(rc["photos"]))]]


# ------------------------------------------------------------------ calls from the page (JSON in, JSON out)
def meta():
    return json.dumps({
        "site_types": core.SITE_TYPES, "op_days": core.OP_DAYS, "issues": core.ISSUES, "nonveg": core.NONVEG,
        "includes": core.INCLUDES, "segregated": core.SEGREGATED, "plant_sizes": core.PLANT_SIZES,
        "followup": core.FOLLOWUP, "lead_status": core.LEAD_STATUS, "photo_tags": core.PHOTO_TAGS,
        "steps": core.steps_for({}), "steps_pre": core.steps_for({"report_type": core.PRE}),
        "steps_post": core.steps_for({"report_type": core.POST}), "report_types": core.REPORT_TYPES,
        "designations": core.DESIGNATIONS, "existing_opts": core.EXISTING_OPTS, "waste_how_opts": core.WASTE_HOW_OPTS,
        "route_opts": core.ROUTE_OPTS, "when_opts": core.WHEN_OPTS, "install_locations": core.INSTALL_LOCATIONS,
        "yes_no": core.YES_NO, "hour_tag": core.HOUR_TAG, "prefixes": core.PREFIXES,
        "waste_how_label": core.WASTE_HOW_LABEL, "step_req_msg": core.STEP_REQ_MSG,
        "rec_p1": core.REC_P1, "rec_p2": core.REC_P2, "org": core.ORG_NAME, "peak_days": core.PEAK_DAYS,
        "examples": {k: [v, label, st] for k, (v, label, st) in core.EXAMPLES.items()},
        "sig_box": [core.SIG_W, core.SIG_H], "photo_box": [core.PHOTO_W, core.BOXH]})


def blank(n, prepared_by, report_type=core.PRE):
    """A new report. n is the running number within the financial year (1, 2, 3...) for this report type."""
    today = date.today()
    fy = core.fy_label(today)
    r = core.new_report(n - 1, report_type)
    r.update(report_no=f"{core.PREFIXES[r['report_type']]}{n:03d}/{fy}", visit_date=today.strftime("%d/%m/%Y"),
             report_date=today.strftime("%d/%m/%Y"), prepared_by=core.cap_words(prepared_by))
    keys = core.step_keys(r)
    ex = [k for k, (_, _, st) in core.EXAMPLES.items() if st in keys]
    for k in ex:   # example amounts, each flagged until changed or confirmed
        r[k] = core.EXAMPLES[k][0]
    r["examples"] = ex
    data = {k: v for k, v in r.items() if k not in META_KEYS}
    return json.dumps({"fy": fy, "data": data, "prefix": core.PREFIXES[r["report_type"]]})


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
    since, avg = core.hour_calc(rc)
    return json.dumps({
        "size": core.effective_size(rc), "missing_count": len(miss), "missing": [[a, b] for a, b in miss],
        "recommendation": core.rec_paragraphs(rc), "followup_open": core.followup_open(rc),
        "summary_rows": summary_rows(rc), "lead_rows": lead_rows(rc), "email_subject": email_subject(rc),
        "steps": core.steps_for(rc), "report_type": core.rtype(rc), "hour_since": since, "hour_avg": avg,
        "wa_number": ("91" + core.mobile_digits(rc["cust_mobile"])) if core.mobile_digits(rc["cust_mobile"]) else "",
        "wa_text": notice_text(rc)})


def layout(data_json, photos_json, view="team"):
    r = full(json.loads(data_json))
    photos = json.loads(photos_json)
    rc = core_view(r, photos)
    files = {str(PHOTO_DIR / p["file"]): p["file"] for p in photos}
    pages = []
    for prims in core.layout_report(rc, view):
        out = []
        for p in prims:
            if p[0] == "photo":
                out.append(["photo", *p[1:5], files.get(p[5]), p[6] if len(p) > 6 else "fill"])
            elif p[0] == "sigimg":
                out.append(["sigimg", *p[1:5], p[6] if len(p) > 6 else "prepared"])   # the page draws that signature here
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


def _render(rc, kind, view="team"):
    fn = {"pdf": core.export_pdf, "docx": core.export_docx, "csv": core.export_csv}[kind]
    path = core.Path(f"/tmp/report.{kind}")
    fn(rc, path, view)
    try:
        return path.read_bytes()
    finally:
        path.unlink()


def export(data_json, photos_json, kind, view="team"):
    r = full(json.loads(data_json))
    return _render(core_view(r, json.loads(photos_json)), kind, "customer" if view == "customer" else "team")


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
        "Lead status": item.get("lead_status", "") if item.get("status") == "sent" else "", "Photos": len(item["photos"]),
        "Type": core.rtype(r), "Report date": r["report_date"],
        "Approved by (customer)": ", ".join(x for x in (r["cust_name"], r["cust_designation"]) if x),
        "Customer mobile": r["cust_mobile"], "Customer email": r["cust_email"],
        "Customer notified": item.get("notice") or ""})


def hour_row(item_json):
    """One row for the Hour metre readings tab, or null for a pre-installation report."""
    item = json.loads(item_json)
    r = full(item["data"])
    if not core.is_post(r):
        return json.dumps(None)
    since, avg = core.hour_calc(r)
    return json.dumps({
        "Customer": r["customer"], "Plant model": r["plant_model"], "Serial number": r["serial_no"],
        "Visit date": r["visit_date"], "Reading (hrs)": r["hour_reading"], "Previous reading (hrs)": r["prev_reading"],
        "Previous reading date": r["prev_reading_date"], "Meter reset": r["meter_reset"],
        "Hours since last reading": "" if since is None else since, "Average hrs per day": "" if avg is None else avg,
        "Prepared by": r["prepared_by"]})


BULK_COLS = ["Report no.", "Type", "Customer", "Visit date", "Report date", "Status", "Lead status", "Address", "Site type",
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
    return [r["report_no"], core.rtype(r), r["customer"], r["visit_date"], r["report_date"], "completed" if done else "in progress",
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
    kind = "Post-installation report" if core.is_post(rc) else "Site visit report"
    return f"{kind} | {cust} | {rc['report_no']} | {core.fmt_date(rc.get('report_date') or rc['visit_date'])}"


def email_content(data_json, photos_json, extra_json):
    """Pre-built email for the internal team: subject, plain text and HTML. extra: note, sender, folder_url, files."""
    r = full(json.loads(data_json))
    rc = core_view(r, json.loads(photos_json))
    extra = json.loads(extra_json or "{}")
    people = [p for p in r["people"] if p.get("name") or p.get("contact")]
    contact = "; ".join(", ".join(x for x in (p.get("name", ""), p.get("designation", ""), p.get("contact", "")) if x)
                        for p in people)
    how = core.waste_how_line(r)
    waste = f"{r['waste_kg']} kg per day" + (f" ({how})" if how else "") if r["waste_kg"] else ""
    space = f"{r['plant_l']} x {r['plant_w']} ft" if r["plant_l"] and r["plant_w"] else ""
    follow = core.followup_line(rc).replace(" – ", ", ").replace("—", "").strip(", ")
    rows = [("Report no.", r["report_no"]), ("Customer", r["customer"]), ("Visit date", core.fmt_date(r["visit_date"])),
            ("Address", r["address"].replace("\n", ", ")), ("Site type", r["site_type"]), ("Contact on site", contact),
            ("Waste generated", waste), ("Meals per day", r["meals"]), ("People served per day", r["served"]),
            ("Recommended plant", core.effective_size(rc)), ("Space available", space),
            ("Distance to kitchen", f"{r['dist']} m" if r["dist"] else ""), ("Follow-up visit", follow),
            ("Prepared by", r["prepared_by"])]
    if core.is_post(r):
        since, avg = core.hour_calc(rc)
        rows = [("Report no.", r["report_no"]), ("Type", core.POST), ("Customer", r["customer"]),
                ("Visit date", core.fmt_date(r["visit_date"])), ("Report date", core.fmt_date(r["report_date"])),
                ("Address", r["address"].replace("\n", ", ")), ("Contact on site", contact),
                ("Plant", " ".join(x for x in (r["plant_model"], r["serial_no"]) if x)),
                ("Hour metre reading", f"{r['hour_reading']} hrs" if r["hour_reading"] else ""),
                ("Hours since last reading", "" if since is None else f"{since:g} hrs"),
                ("Waste generated", waste), ("Follow-up visit", follow), ("Prepared by", r["prepared_by"])]
    rows.append(("Approved by customer", ", ".join(x for x in (r["cust_name"], r["cust_designation"]) if x)))
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
    text += ["", "Regards,", sender or "AVRIS site team", "AVRIS Environment Technologies Private Limited"]
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
    html.append(f"<p>Regards,<br>{esc(sender or 'AVRIS site team')}<br>AVRIS Environment Technologies Private Limited</p></div>")
    return json.dumps({"subject": email_subject(rc), "text": "\n".join(text), "html": "".join(html)})


# ---------------------------------------------------------------- message to the customer (WhatsApp or email)
def notice_text(rc):
    """Short message telling the customer they approved the report. Plain words, no internal details."""
    name = str(rc.get("cust_name") or "").strip() or "Sir/Madam"
    kind = "post-installation visit report" if core.is_post(rc) else "site visit report"
    return (f"Dear {name},\n\nThank you. You have approved the AVRIS {kind} {rc['report_no']} "
            f"for {_val(rc['customer'], 'your site')}, visit date {core.fmt_date(rc['visit_date'])}.\n\n"
            f"Prepared by: {_val(rc['prepared_by'], 'AVRIS team')}\n"
            f"AVRIS Environment Technologies Private Limited")


def notice_content(data_json, photos_json):
    """Email to the customer, with their copy of the report attached by the page."""
    r = full(json.loads(data_json))
    rc = core_view(r, json.loads(photos_json))
    text = notice_text(rc) + "\n\nYour copy of the report is attached as a PDF."
    esc = lambda s: (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    html = ('<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;font-size:14px;line-height:1.5">'
            + "".join(f"<p>{esc(par).replace(chr(10), '<br>')}</p>" for par in text.split("\n\n")) + "</div>")
    return json.dumps({"subject": f"AVRIS visit report {r['report_no']} approved", "text": text, "html": html,
                       "to": str(r["cust_email"]).strip().lower()})

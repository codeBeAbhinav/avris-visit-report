"""
AVRIS Visit Report, web core.
Framework-free logic taken from the desktop tool (avris_visit_report_v2.py):
report data helpers, A4 layout, and the stdlib PDF / Word / CSV exporters.
"""
import base64 
import csv
import io
import json
import math
import os
import re
import shutil
import struct
import sys
import uuid
import zipfile
import zlib
from datetime import date, datetime
from pathlib import Path
from xml.sax.saxutils import escape as xesc

try:  # optional, only used for photos
    from PIL import Image, ImageOps
except Exception:  # pragma: no cover
    Image = ImageOps = None

# ---------------------------------------------------------------- design tokens
GROUND = "#ffde58"   # color/ground
INK = "#111827"      # color/ink
SLATE = "#3a4152"    # color/slate
CARD = "#ffffff"     # color/card
GREEN = "#5be400"    # color/green
GOLD = "#b99f3c"     # color/gold
RED = "#d92d20"      # remove / delete

# Footer text on every report page. Override with the ORG_NAME environment variable.
ORG_NAME = os.environ.get("ORG_NAME", "Environment Technologies Private Limited")

DATA_DIR = Path(os.environ.get("AVRIS_DATA") or (Path.home() / "AVRIS_Visit_Reports"))
DATA_FILE = DATA_DIR / "reports.json"
EXPORT_DIR = DATA_DIR / "exports"
PHOTO_DIR = DATA_DIR / "photos"

SITE_TYPES = ["Hotel", "Restaurant", "Hospital", "Campus", "Mall / Office",
              "Housing society", "Industry canteen", "Other"]
OP_DAYS = ["5 days", "6 days", "7 days"]
ISSUES = ["Smell", "Pests", "Cost", "Hygiene", "Space", "Landfill ban"]
NONVEG = ["None", "Some (under 25%)", "Mixed (25–50%)", "Mostly (over 50%)"]
INCLUDES = ["Cooked food", "Raw / peelings", "Plate leftovers", "Expired / packaged", "Bones / shells"]
SEGREGATED = ["Yes", "Partly", "No"]
PLANT_SIZES = ["CHUGG 75", "CHUGG 150"]
FOLLOWUP = ["Yes", "Maybe", "No"]
LEAD_STATUS = ["New", "Contacted", "Quoted", "Won", "Lost"]
PHOTO_TAGS = ["Plant spot", "Kitchen", "Waste", "Route", "Other"]

STEPS = [
    ("Visit basics", "Fill these before you leave the car. Fields marked * are required."),
    ("People met", "Who did you speak to? Add everyone useful for follow-up."),
    ("Site type and scale", "What kind of place is it, and how big?"),
    ("Today's situation", "What is going wrong with waste now, and how is it handled today?"),
    ("Waste numbers", "Food waste only. Leave out paper and plastics."),
    ("Waste profile", "What is in the waste, and how is it handled in the kitchen?"),
    ("Space and route", "Feet for the plant space, metres to the kitchen."),
    ("Photos", "Plant spot, kitchen, waste, route. Add a short caption to each."),
    ("Recommendation", "Pick the plant size. The standard text fills in on its own."),
    ("Follow-up and remarks", "Is another visit needed? Anything else the team should know?"),
    ("Check and send", "Fill anything still missing. You can send once every item is done."),
]
N_STEPS = len(STEPS)

REC_P1 = ("We recommend to install {size} which can process up to {cap} kg of food waste per day. "
          "As the system is modular, additional digesters can be added in the future to "
          "accommodate any increase in food waste generation.")
REC_P2 = ("By installing the CHUGG food waste treatment system, there is no need to store food waste, "
          "ensuring better hygiene and on-site processing. It reduces landfill dependency, waste "
          "transportation, and carbon emissions, aligning with sustainability and ESG objectives.")

WASTE_HOW_LABEL = "How are you calculating the waste per day or the waste generated?"
STEP_REQ_MSG = "Are you sure you want to proceed? There are required forms which have not been filled."

# Logos cropped from the Figma report band (palette PNGs; s60/s100/s122 = pixels per point x 100)
LOGO_B64 = {
    "avris_s60":
        "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"
        "4emeITN0heYAAAAASUVORK5CYII=",
    "avris_s100":
        "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"
        "DxTgczpi6dP0AAAAAElFTkSuQmCC",
    "avris_s122":
        "iVBORw0KGgoAAAANSUhEUgAAAKsAAAA4CAMAAAC1xPjGAAABIFBMVEX/4mv/4Wb/4GX/4GP/4GL/4GH/4GD/32L/32H/"
        "32D/4F7/31//317/313/31z/31v/31r55YLx54b75Hnz5Xj+43P+4nD84nH84XD44XTz4Xb+4m7+4m3+4mv+4Wv+4mj+"
        "4Wf+4GP+32H74Wvl6IrS6Ynp4n3b4nzE6Xy54n+x5m2j5l2R5UuF5D985C5y4iJp4RZk4RBl4BNg4Qpc4AT/3l3/3lv/"
        "3lr/3ln/3ljy2nv13HD93WDs3Hry12/q1njoz23mymbc2oLfzXjbxnvhxmrJ1YjFzHy0zYOkyILZwHDRuGzCsnK9o2Gz"
        "mGGavXl9s3Ofi1lgommNbkKFYz6BXjd7WDB2USxxSiNqRSBrQxtqQRpoPxhmOxNlORFlOQ8x2uzeAAANKUlEQVR42tWZ"
        "aVvizNLHDZWwGEYFBGRN2BncxltRRgaQsMuSAIoMKn7/b/FUEpLuBPDcL54X59R1DU6STvcvleqqf3cOfm/bPW2Ve6tV"
        "7K0f7u1GXazsuVM9fNA7r1j7+m0d0Gil/vdgG/UBaOMsRyzrtDd3gd28Hs406rTTOgS3+UedvscBtFtYj2dz06HHRPix"
        "g7XCwV7jXIf25l74l+a2uYPdeoRj9IXelOcNVi/LpBp1Zg/rw7cjeu3NeXuL0J47D3kbq8vKWv5978JzHsQ9JMMB05pO"
        "pkNhP6uA15zsrhGd3/jVbflj8an2yxuxeQROgDTHsVSH+utk08lAIBCkWOvT0WQ0Ge5lTWRzuvmxufH/XC4b2sfqN9vk"
        "fNBqP7c39tzpPLc7nadMICg4ObcRQOUz9eIQm3UyDvMFuT0HndF0/vL29jqfDltBh0bbaY+70/YkaGcts2WPGjLZyxvd"
        "LjIQzF1vDm6ussltVi0Gfho33FxmH99WdlsuFjh6M+kql8ssy5fdtem7anhpHHvQRi6XU4nhfPm+/tLtY/k6rh9g183h"
        "eDRpj7ZYN7MqWbrb2K8CBE8vjKO7nxH4YWdVZ2zg0mhxex5q/f3aZeu/i8mTMaMeX4zTk+TJppen6eprvabu+HgZoW/r"
        "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",
    "chugg_s60":
        "iVBORw0KGgoAAAANSUhEUgAAAEkAAAAVCAMAAAA94TNiAAABIFBMVEX/7V7/6l3/6V3/6Fz/51z/5lz/5lv/5lr/5Vv/"
        "5Fv/41r/4lr/4Vn/4Vj/4Fj/31n/31j/3lj/3lf/3Vj+5Fr+3lj+3Vj+3Vf93Vj+3Ff93Ff83Ff921f821f82lb23Vj4"
        "2lf52Vbz1FTvzVHk0FPlw0zE0VagxlThvUrcuUjWskXYq0HNqEHLpT+pskjAmjqyizSqgjClfC2fdiuacSiUaiVbtFA0"
        "qU4ipU0dpE0cpE0bpE0bo00ao00Yok0UoU0PoEwLnkyGWh59URp4SxhyRRZuQRNrPhJrPRJqPBFpOxFoOhFoOhBnOhBn"
        "ORBmOBBlNw9kNg9jNA5iMw1hMg1gMg1gMQ1fMQxgMAxfMA1fMAxfLwxeLwxdMAxdLgtXJwgb8buyAAAERUlEQVR42pWU"
        "23aiSBRAuYUGpQnViReIaIKiSHQpKqAZ72gUQxAkid0MDf//F1NgemZ6zdMcHwoP1Kaoc2oj4H9EucCxLFco//fONQBI"
        "dlEUAMeVBAAEURDShFARBL4iVC43hUoRjoUCw9YajRrLgAL8pU/BZ4tiCc6tcheSwGCsKFI44K9QDOcAuCFRjKBQDIPv"
        "usljOJq/AWWWbRnmeDI2mhwLuAIQOJxkWRrN8Yzal/MpiSelvm6tRx0Gf9S0/sM1n1cHWk+9XOfkgabJuTu2YSyXi/ls"
        "vlwatabxVSCF7lDXR32ZvO5qbRqSBKKzjd98Pwr1up7Edj0v4sMk2QyT2JNzIt5NwqRLfGuYq8lkCmMyWZnGskmoVhgF"
        "wUeyUSRJeWARwBPd02nnRR8vz8lw8HbYQBKhvbvWMLC3kER0gl3QJWrmcjLLYrJYmvNxs/f+tneCN9/ex32UYQEi5ORn"
        "3/6whvouseqj8LitM1VqEPvWMHSfU1L3bJ+7aOsTNJ2vTLhfNcXz9ufdWrf8eC0V4NYjAjmId++De4ps6woy+jhuHzAG"
        "0X4nRZ3aeP6Ucp5mY6PVNA1SD3dnXWbAQ2ct02mNEUbauu86zQhFmuZuRz/c547SbuvBKSPVL6Sfj81VuqTpYrEwDKNl"
        "NGT/EKzvKA5HERTF2ZREtb3DuYtVASiVRHIUHo6u47ieE1jD6O81/XxsZaTZGK7nD8Nsor3zPuzgZUnLQmIKAMG7J3ev"
        "0KWsr1LSqwvDyUjOTqH/TZouWl+YWsMwv2H96OAot8V7K4niOE7nI0THdw/KbUoqZSTP9zzv+EmS6d++bj5u1b405uY9"
        "2oeLV6gq1k1c23baFA+/TjnacQ+twkORq5Bp7bqqqmb7lJJuq2QvtM+PzcX0UjijZS5NCe+F+wjOYiTN8h0vI7EPG9/b"
        "1DGQJ+QCOfrwNiJGI4MQ1i6Cr0UriBbtz+qtuchqN1mu5k/zJim/OP5GQgGH9GP7QhLwfrwLLPW+3nd7WRfUC9XbISRp"
        "b/a7Lt2pW885KvivfnqaTCerVi4/ivbBWn2o1oY/DhdS8fp+He0Cf/N8Pr73hlHamQI1DL1Nx3NeTlvL9Xd/rsuFmrn4"
        "7PHZdGY2SHl32genzXpzdF5eFQruOCjl6pv4YB9f98dE+4d03Eqj5GXveofD99c2dfe1tVhMnn6du0aJUnfhwfb848EN"
        "IjmtHVQBVdc9WMq3bY8YxX5GGsSnrXCfpWN/rZI8KDNNc7WczzIXNJiycKWs/SiK4g/HgsooZn7i83mlp/W7EsHUVbVd"
        "BEU2HXkmTWt9lcu6rcxILWM8SU8LYKH5eJpr9wbQPoqIX4NPZ5YAjWIozgg3+asrKs0w6Vi8oVGYJwF/cS+X52qNZoPL"
        "X4zJAwolSAyjuUyzF/sCXhRFoZiZVvg0bjqWRLEiCr9kXbgDqcehzj8TqavFSuny5y/Uf/7prmy1WwAAAABJRU5ErkJg"
        "gg==",
    "chugg_s100":
        "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",
    "chugg_s122":
        "iVBORw0KGgoAAAANSUhEUgAAAJUAAAAqCAMAAACN4OndAAABIFBMVEX/3ljx21jx21fx21bx2lf11VP11FPi2Fbj11fj"
        "11bj11Xi1lf101Tsyk/ryk/syU/ryU/jwErjv0riv0vatkbatUbatEbU01XZtUbG0FXF0FXGz1W3zFW4y1S3y1WwylWp"
        "yFSpx1SgxVSbxFPQq0HPqkKMwVKNwFJ+vlF+vFJ3u1JwuVFwuFFitVFUslBTslBFr1BGrk9FrU83q083q044qk44qk03"
        "qk42qk8pp04pp00ppk0op04ao03HoT3GoT3HoD3GoD29lji8lji8lTmzjDSyjDSzizSyizSpgjCqgS+pgTCgdyufdyuY"
        "byiXbCaWbCeNYyKNYiKNYSKDWB6DWB2EVx16Thl5Thl6TRl5TRlwRBVxQxRwQxRwQhRnORDHDrIsAAAEDklEQVR42u2Y"
        "e1PaQBDATyopUgEVLRGkowNKGUG0aH2eSpRGMR1ppJVHMd//W/QuuZB7BmWw4x/uDAO57N3+2Nvb2zsA3uVdQmUul8tF"
        "3hLQh1x57xRiOazkntfFMM3U6zJteUREDtef0afR+HndFFq189a9bdutojZqSSChNPBjQlO00w25A8iJyxWvrlHmdKOJ"
        "5HzZb2jqnc0LjmnBenJ8sVxH3pIHX0P3ngeg5/1Y8l+kSbeR+79CiZQB2IZwxh/MDszZDeKrzRbrK+3WYeQGtdmkD0fl"
        "APLd4F8QzPgelEo1hl5kCRNrziJYRpRxVMfhpJ9SUmkqqhUvpA6gQnColWOiCxznfnlZjPOFniNIX1NRpcKp9mColCQu"
        "cANDewaU0wWTUW0oefZP0KcENJk1yowvlgwqMRlVXDV/tdV1COeQRlsK1Y3yeSLgNXTdeCBQk1Fty5nqeZCD8Iix5tgt"
        "0zQ9yGGCd5Xv0a5OKB+dYRpMRhWXQ5UjIIOcWAPU/NnEXBLZczaBwlXdEW6yhaEmopK66jgfr1T281W4TrnqOiBItq+F"
        "BWjzUNwLm8cPozqQTR7efsqRPKxTE3MTvvvMi+ws1cA4d8Wwx1NlJJ7a2UFLr5DfOa3PBduANWZPHOVGFZUgIVQ5IaAy"
        "J9hdhSqEu3gBXjGpzdtQiTAAV4p0MZ7KFKm4ZFVfRSVWxQ2tk7MIlYQGpCeT5Gks8uLuFahK3utINvsxA3dlsaoz44op"
        "1JwKFTuDW6OhEO2ZdAX9osZdomw3p0n1iSuqYkQDL82YjKpIjbsixpU1FapZPtorLssW/umq3nuav0cZ4K+cqsHGn0g1"
        "xPsCFltF1QiG3ZfVoC6UV+9ZfGT/kFP5Nj6rqCxVFjU5d+NwleT2wx3vO0urBkm0WLyVUAHiw/7kVLcBlbqO8WLf7ztI"
        "iVseQ+WPSeUGI/WcHcfmt3c0LbMnSqpdZtHZYh5nqJL+vN6RyUZFaEcLo/IjdJNtd0OzpKQ6Ysum+1Sor4IE28d7iNbE"
        "hw+MpaTy/+/A1b96ov9+iLNm2AzV905SQGtLqeYfg3XQ82cDYSmpgnXzZHeCA5S3LxaUVLUZPp130PGzJ12DfN4f9VBT"
        "LcprXKKmdtY3PhewssittguZkqakkpfefjlZCDneuHKnys5gPNaN0lcaM+eOkIFUAV+WZM5QKlDk7OAaXkWF1+2jGgqA"
        "L9+lR2cqQ0n+ldOWFH9J+vg1NKMhO6mgjjKtzl5bVcTavaC05q4yc1FelCYbD0NXwbr0zmZJb/tLj9Zq0X2+ZNWdoW1E"
        "hcE2WHcdlyKCtTZx2PBP6zIRXi8nEi+6pkKFbVR1zVeokSus41pBft8X1XU9/TKD05BIdm19LfOmriDf5T/IP6VMmkDv"
        "IQq/AAAAAElFTkSuQmCC",
}


# ---------------------------------------------------------------- data helpers
def blend(c1, c2, a):
    """Mix colour c1 over c2 at opacity a (used for the disabled Send button)."""
    p = lambda c: [int(c[i:i + 2], 16) for i in (1, 3, 5)]
    r = [round(x * a + y * (1 - a)) for x, y in zip(p(c1), p(c2))]
    return "#%02x%02x%02x" % tuple(r)


def hex_rgb(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def fy_label(d):
    y = d.year if d.month >= 4 else d.year - 1
    return f"{y % 100:02d}-{(y + 1) % 100:02d}"


def new_report(existing_count):
    today = date.today()
    return {
        "id": uuid.uuid4().hex, "status": "draft", "lead_status": "New", "step": 0,
        "updated": datetime.now().isoformat(timespec="seconds"),
        "report_no": f"Avris/CHUGG/S.A/{existing_count + 1:03d}/{fy_label(today)}",
        "customer": "", "visit_date": today.strftime("%d/%m/%Y"), "prev_visit": "", "address": "",
        "people": [{"name": "", "designation": "", "contact": "", "email": ""}],
        "site_type": "", "site_area": "", "served": "", "kitchen_staff": "", "op_days": "",
        "issues": [], "issues_text": "", "existing_system": "",
        "waste_kg": "", "waste_how": "",
        "meals": "", "nonveg": "", "includes": [], "segregated": "", "peak": "", "bulk": "",
        "plant_l": "", "plant_w": "", "dist": "",
        "photos": [], "plant_size": "", "rec_extra": "",
        "followup": "", "followup_when": "", "remarks": "",
        "prepared_by": "", "prepared_sig": [],
    }


def num(s):
    try:
        return float(re.sub(r"[^\d.]", "", str(s)) or 0)
    except ValueError:
        return 0.0


def size_cap(size):
    m = re.search(r"\d+", size or "")
    return int(m.group()) if m else 0


def effective_size(r):
    if r["plant_size"]:
        return r["plant_size"]
    if not num(r["waste_kg"]):
        return ""
    return "CHUGG 75" if num(r["waste_kg"]) <= 75 else "CHUGG 150"


def fmt_date(s):
    try:
        return datetime.strptime(s.strip(), "%d/%m/%Y").strftime("%d %b %Y")
    except ValueError:
        return s or "—"


def dash(s):
    return s if str(s).strip() else "—"


def followup_open(r):
    """When and Remarks only apply if another visit may happen."""
    return r["followup"] in ("Yes", "Maybe")


def missing(r):
    """Required items still empty, as (label, step index)."""
    m = []

    def need(ok, label, step):
        if not ok:
            m.append((label, step))

    need(r["report_no"].strip(), "Report no.", 0)
    need(r["customer"].strip(), "Customer name", 0)
    need(r["visit_date"].strip(), "Date of visit", 0)
    need(r["address"].strip(), "Address", 0)
    p = r["people"][0] if r["people"] else {}
    need(p.get("name", "").strip(), "Person met: name", 1)
    need(p.get("contact", "").strip(), "Person met: contact number", 1)
    need(r["site_type"], "Type of site", 2)
    need(r["served"].strip(), "People served per day", 2)
    need(r["op_days"], "Operating days per week", 2)
    need(r["existing_system"].strip(), "Existing waste disposal system", 3)
    need(r["waste_kg"].strip(), "Waste per day (kg)", 4)
    need(r["waste_how"].strip(), "How the waste per day is calculated", 4)
    need(r["meals"].strip(), "Meals served per day", 5)
    need(r["nonveg"], "Non-veg share of waste", 5)
    need(r["includes"], "What the waste includes", 5)
    need(r["segregated"], "Segregated at source", 5)
    need(r["plant_l"].strip() and r["plant_w"].strip(), "Plant space length and width", 6)
    need(r["dist"].strip(), "Distance from site to kitchen", 6)
    need(r["followup"], "Follow-up visit needed", 9)
    if followup_open(r):
        need(r["followup_when"].strip(), "Follow-up: when", 9)
    need(r["prepared_by"].strip(), "Prepared by: name", 10)
    need(r["prepared_sig"], "Prepared by: signature", 10)
    return m


def issues_line(r):
    s = ", ".join(r["issues"])
    t = r["issues_text"].strip()
    if s and t:
        return f"{s}. {t}"
    return s or t or "—"


def rec_paragraphs(r):
    size = effective_size(r) or "CHUGG 150"
    ps = [REC_P1.format(size=size, cap=size_cap(size))]
    if r["rec_extra"].strip():
        ps.append(r["rec_extra"].strip())
    ps.append(REC_P2)
    return ps


def followup_line(r):
    if not r["followup"]:
        return "—"
    if r["followup"] == "No":
        return "No"
    return f"{r['followup']} – {r['followup_when'].strip() or '—'}"


def build_pages(r):
    """The 3 logical report pages, shared by the preview, PDF and Word export."""
    no, cust = r["report_no"], r["customer"]
    people = []
    for p in r["people"]:
        bits = [p.get("name", ""), p.get("designation", ""), p.get("contact", ""), p.get("email", "")]
        line = ", ".join(b for b in (x.strip() for x in bits) if b)
        if line:
            people.append(line)
    size = effective_size(r)
    cap = size_cap(size)
    kg, meals = num(r["waste_kg"]), num(r["meals"])
    per_meal = f"{round(kg * 1000 / meals)} g per meal" if kg and meals else "—"
    util = (f"{round(kg / cap * 100)}% of {size} capacity ({r['waste_kg']} of {cap} kg/day)"
            if kg and cap else "—")
    space = f"{r['plant_l']} × {r['plant_w']} ft" if r["plant_l"] and r["plant_w"] else "—"
    waste = f"{r['waste_kg']} kg – {r['waste_how']}" if r["waste_kg"] else "—"
    remarks = dash(r["remarks"]) if followup_open(r) else "—"

    p1 = {"title": "Customer Visit Report – CHUGG",
          "sub": [f"S.No: {no}    Date: {fmt_date(r['visit_date'])}", f"Name: {cust}"],
          "blocks": [
              ("row", 1, "Date/s of Visit/Tour", fmt_date(r["visit_date"])),
              ("row", 2, "Date of previous visit", fmt_date(r["prev_visit"]) if r["prev_visit"].strip() else "None"),
              ("row", 3, "Customer Name", dash(cust)),
              ("row", 4, "Address", dash(r["address"])),
              ("row", 5, "Persons met with designation, contact and email", "\n".join(people) or "—"),
              ("row", 6, "Present issues in waste disposal", issues_line(r)),
              ("row", 7, "Existing waste disposal system", dash(r["existing_system"])),
              ("row", 8, "Waste per day in kgs (excluding paper/plastics)", waste),
              ("row", 9, "Space availability for installation of CHUGG Plant (in feet)", space),
              ("row", 10, "CHUGG plant size recommended", dash(size)),
              ("row", 11, "Distance from site to kitchen (in meters)",
               f"{r['dist']} m" if r["dist"] else "—"),
              ("row", 12, "Follow up visit required / when", followup_line(r)),
              ("row", 13, "Remarks", remarks),
          ]}
    p2 = {"title": "Site and waste profile",
          "sub": [f"Customer: {cust}     Report no. {no}"],
          "blocks": [
              ("sec", "Site type and scale"),
              ("row", 14, "Type of site", dash(r["site_type"])),
              ("row", 15, "Site area", f"{r['site_area']} sq ft" if r["site_area"] else "—"),
              ("row", 16, "People served per day", dash(r["served"])),
              ("row", 17, "Kitchen staff", dash(r["kitchen_staff"])),
              ("row", 18, "Operating days per week", r["op_days"].split()[0] if r["op_days"] else "—"),
              ("sec", "Waste profile"),
              ("row", 19, "Meals served per day", dash(r["meals"])),
              ("row", 20, "Non-veg share of waste", dash(r["nonveg"])),
              ("row", 21, "Waste includes", ", ".join(r["includes"]) or "—"),
              ("row", 22, "Segregated at source", dash(r["segregated"])),
              ("row", 23, "Peak days or times", dash(r["peak"])),
              ("row", 24, "Bulk generators", dash(r["bulk"])),
              ("sec", "Calculated"),
              ("row", 25, "Waste per meal", per_meal),
              ("row", 26, "Plant utilisation", util),
          ]}
    photos = [(ph.get("caption", "").strip() or ph.get("tag", "") or "Photo", ph.get("path", ""))
              for ph in r["photos"]]
    p3 = {"title": None, "sub": [],
          "blocks": [("h", "Photographs"), ("photos", photos), ("h", "Recommendation")]
                    + [("p", t) for t in rec_paragraphs(r)]
                    # Approved by stays on the printed report as a blank line for a manager to sign by hand.
                    + [("sign", [("PREPARED BY", r["prepared_by"].strip(), r["prepared_sig"]),
                                 ("APPROVED BY", "", None)])]}
    return [p1, p2, p3]


# ---------------------------------------------------------------- A4 layout (points, y from the top)
PW, PH = 595, 842
MX, CW = 46, 502                  # left margin, content width
BAND = 74                         # yellow header band
COLS = (28, 176, 298)             # No. | field | value
LIMIT = PH - 52                   # content must end above the footer
BOXH = 118                        # photo box height
LOGO_BOX = {"avris": (43.5, 15.5, 140.5, 46.0), "chugg": (429.0, 20.5, 122.5, 34.5)}

_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 + \
       [278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
        722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556,
        556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
        500, 722, 500, 500, 500, 334, 260, 334, 584]
_BLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 + \
       [333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833,
        722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556,
        611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611,
        556, 778, 556, 556, 500, 389, 280, 389, 584]


def text_w(s, size, bold=False):
    t = _BLD if bold else _REG
    tot = 0
    for ch in s:
        o = ord(ch)
        tot += t[o - 32] if 32 <= o < 127 else (584 if ch == "×" else 556)
    return tot * size / 1000.0


def wrap(s, width, size, bold=False):
    out = []
    for para in str(s).split("\n"):
        line = ""
        for word in para.split(" "):
            cand = word if not line else line + " " + word
            if text_w(cand, size, bold) <= width or not line:
                line = cand
            else:
                out.append(line)
                line = word
        out.append(line)
    final = []
    for ln in out:  # break a single over-long word
        while text_w(ln, size, bold) > width and len(ln) > 1:
            k = len(ln)
            while k > 1 and text_w(ln[:k], size, bold) > width:
                k -= 1
            final.append(ln[:k])
            ln = ln[k:]
        final.append(ln)
    return final or [""]


def layout_report(r):
    """Turn the logical pages into drawing primitives for each physical A4 page."""
    pages, st = [], {}

    def new_page(first_y=BAND + 18):
        cur = [("rect", 0, 0, PW, BAND, GROUND, None, 0)]
        for key, (x, y, w, h) in LOGO_BOX.items():
            cur.append(("logo", x, y, w, h, key))
        pages.append(cur)
        st["cur"], st["y"] = cur, first_y

    def ensure(h):
        if st["y"] + h > LIMIT:
            new_page()

    def add(p):
        st["cur"].append(p)

    for spec in build_pages(r):
        new_page()
        if spec["title"]:
            add(("text", MX, 90, spec["title"], 19, True, INK, "l"))
            y = 115
            for s in spec["sub"]:
                add(("text", MX, y, s, 10, False, INK, "l"))
                y += 12
            st["y"] = y + 10
        else:
            st["y"] = 88
        for b in spec["blocks"]:
            k = b[0]
            if k == "row":
                _, n, label, value = b
                lw = wrap(label, COLS[1] - 14, 10, True)
                vw = wrap(value, COLS[2] - 14, 10)
                lines = max(len(lw), len(vw))
                h = max(21.5, lines * 12.5 + 9)
                ensure(h)
                y, x = st["y"], MX
                for i, w in enumerate(COLS):
                    add(("rect", x, y, w, h, None, INK, 0.8))
                    x += w
                add(("text", MX + COLS[0] / 2, y + 4.5, str(n), 10, True, INK, "c"))
                for i, t in enumerate(lw):
                    add(("text", MX + COLS[0] + 7, y + 4.5 + i * 12.5, t, 10, True, INK, "l"))
                for i, t in enumerate(vw):
                    add(("text", MX + COLS[0] + COLS[1] + 7, y + 4.5 + i * 12.5, t, 10, False, INK, "l"))
                st["y"] += h
            elif k == "sec":
                ensure(21.5)
                y = st["y"]
                add(("rect", MX, y, CW, 21.5, GROUND, INK, 0.8))
                add(("text", MX + CW / 2, y + 4.5, b[1], 10, True, INK, "c"))
                st["y"] += 21.5
            elif k == "h":
                ensure(34)
                add(("text", MX, st["y"], b[1], 12.5, True, INK, "l"))
                st["y"] += 21
            elif k == "p":
                lines = wrap(b[1], CW, 10)
                ensure(13 * len(lines))
                for t in lines:
                    add(("text", MX, st["y"], t, 10, False, INK, "l"))
                    st["y"] += 13
                st["y"] += 6
            elif k == "photos":
                items = b[1]
                if not items:
                    ensure(16)
                    add(("text", MX, st["y"], "No photos added.", 10, False, SLATE, "l"))
                    st["y"] += 20
                for i in range(0, len(items), 2):
                    pair = items[i:i + 2]
                    caps = [wrap(c, 244, 8.5)[:2] for c, _ in pair]
                    rowh = BOXH + 4 + max(len(c) for c in caps) * 10.5 + 12
                    ensure(rowh)
                    for j, (cap, path) in enumerate(pair):
                        x = MX + j * (244 + 14)
                        add(("rect", x, st["y"], 244, BOXH, CARD, INK, 0.8))
                        add(("photo", x, st["y"], 244, BOXH, path))
                        for q, t in enumerate(caps[j]):
                            add(("text", x, st["y"] + BOXH + 4 + q * 10.5, t, 8.5, False, SLATE, "l"))
                    st["y"] += rowh
            elif k == "sign":
                yb = max(st["y"] + 24, 723)
                if yb + 72 > PH - 40:
                    new_page()
                    yb = st["y"] + 24
                for j, (lab, name, strokes) in enumerate(b[1]):
                    x = MX if j == 0 else MX + 271
                    wline = 233 if j == 0 else CW - 271
                    add(("text", x, yb, lab, 8, True, SLATE, "l"))
                    if strokes:
                        add(("sig", x, yb + 10, wline, 36, strokes))
                    add(("line", x, yb + 48, x + wline, yb + 48, INK, 0.8))
                    if name:
                        add(("text", x, yb + 53, name, 10.5, True, INK, "l"))
    total = len(pages)
    for i, pg in enumerate(pages):
        pg.append(("text", MX, 806, f"{ORG_NAME} · Page {i + 1} of {total}", 8, False, SLATE, "l"))
    return pages


# ---------------------------------------------------------------- images (stdlib only)
def png_decode(data, bg=(255, 255, 255), max_px=6_000_000):
    """8-bit, non-interlaced PNG to (w, h, rgb bytes). Alpha is blended over bg."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, idat, plte, trns, hdr = 8, b"", None, None, None
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ, chunk = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b"IHDR":
            hdr = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"PLTE":
            plte = chunk
        elif typ == b"tRNS":
            trns = chunk
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
    w, h, bd, ct, _, _, il = hdr
    if bd != 8 or il or ct not in (0, 2, 3, 4, 6) or w * h > max_px:
        raise ValueError("unsupported PNG")
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = w * ch
    raw = zlib.decompress(idat)
    rgb, prev, p = bytearray(), bytearray(stride), 0
    for _ in range(h):
        f = raw[p]
        line = bytearray(raw[p + 1:p + 1 + stride])
        p += 1 + stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        prev = line
        if ct == 2:
            rgb += line
        elif ct == 0:
            for v in line:
                rgb += bytes((v, v, v))
        elif ct == 3:
            for v in line:
                rgb += plte[v * 3:v * 3 + 3]
        elif ct == 4:
            for i in range(0, stride, 2):
                v, a = line[i], line[i + 1] / 255
                rgb += bytes(round(v * a + c * (1 - a)) for c in bg)
        else:
            for i in range(0, stride, 4):
                a = line[i + 3] / 255
                rgb += bytes(round(line[i + k] * a + bg[k] * (1 - a)) for k in range(3))
    return w, h, bytes(rgb)


def png_encode(w, h, rgb):
    raw = b"".join(b"\x00" + rgb[y * w * 3:(y + 1) * w * 3] for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def jpeg_info(data):
    """(w, h, components) from the first SOF marker, or None."""
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        m = data[i + 1]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
            i += 2
            continue
        ln = struct.unpack(">H", data[i + 2:i + 4])[0]
        if m in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h, data[i + 9]
        i += 2 + ln
    return None


def logo_png(key, variant="s122"):
    """PNG bytes for a logo. A file named <key>_logo.png beside the script or in the data folder wins."""
    for d in (Path(__file__).resolve().parent, DATA_DIR):
        p = d / f"{key}_logo.png"
        try:
            if p.is_file():
                return p.read_bytes()
        except OSError:
            pass
    return base64.b64decode(LOGO_B64[f"{key}_{variant}"])


def load_photo(path, maxdim=1600):
    """Photo for export: {'kind': 'jpeg'|'rgb', 'w', 'h', 'comps', 'data'} or None if unreadable."""
    try:
        data = Path(path).read_bytes()
    except OSError:
        return None
    if Image is not None:
        try:
            im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
            im.thumbnail((maxdim, maxdim))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=85)
            return {"kind": "jpeg", "w": im.width, "h": im.height, "comps": 3, "data": buf.getvalue()}
        except Exception:
            pass
    if data[:2] == b"\xff\xd8":
        info = jpeg_info(data)
        if info and info[2] in (1, 3):
            return {"kind": "jpeg", "w": info[0], "h": info[1], "comps": info[2], "data": data}
        return None
    try:
        w, h, rgb = png_decode(data)
        return {"kind": "rgb", "w": w, "h": h, "comps": 3, "data": rgb}
    except Exception:
        return None


def fit_box(iw, ih, x, y, w, h, pad=3):
    """Largest iw:ih rectangle centred in the box."""
    aw, ah = w - 2 * pad, h - 2 * pad
    s = min(aw / iw, ah / ih)
    return x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s


def sig_points(strokes, x, y, w, h):
    """Map signature strokes (canvas coords) to a box, keeping the aspect ratio, left aligned."""
    pts = [pt for s in strokes for pt in s]
    if not pts:
        return []
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    bw, bh = max(x1 - x0, 1), max(y1 - y0, 1)
    s = min((w - 4) / bw, (h - 4) / bh, 0.6)
    ox, oy = x + 2, y + (h - bh * s) / 2
    return [[(ox + (px - x0) * s, oy + (py - y0) * s) for px, py in st] for st in strokes if len(st) > 1]


def sig_png(strokes, wpx, hpx):
    """Signature as a white-background PNG (used in the Word file)."""
    buf = bytearray(b"\xff" * (wpx * hpx * 3))
    for st in sig_points(strokes, 0, 0, wpx, hpx):
        for (ax, ay), (bx, by) in zip(st, st[1:]):
            n = max(1, int(max(abs(bx - ax), abs(by - ay)) * 2))
            for i in range(n + 1):
                cx, cy = ax + (bx - ax) * i / n, ay + (by - ay) * i / n
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        px, py = int(cx) + dx, int(cy) + dy
                        if 0 <= px < wpx and 0 <= py < hpx:
                            o = (py * wpx + px) * 3
                            buf[o:o + 3] = b"\x11\x18\x27"
    return png_encode(wpx, hpx, bytes(buf))


# ---------------------------------------------------------------- exports
def safe_name(r):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", r["report_no"]) or "visit_report"


def _pdf_esc(s):
    s = s.encode("cp1252", "replace").decode("latin-1")
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def export_pdf(r, path):
    pages = layout_report(r)
    images, order = {}, []   # key -> object number placeholder data

    def img_obj(key, loader):
        if key not in images:
            images[key] = loader()
            order.append(key)
        return images[key]

    def logo_loader(key):
        def f():
            w, h, rgb = png_decode(logo_png(key), hex_rgb(GROUND))
            return {"w": w, "h": h, "flt": "/FlateDecode", "cs": "/DeviceRGB", "data": zlib.compress(rgb, 6)}
        return f

    def photo_loader(p):
        def f():
            ph = load_photo(p)
            if ph is None:
                return None
            if ph["kind"] == "jpeg":
                return {"w": ph["w"], "h": ph["h"], "flt": "/DCTDecode",
                        "cs": "/DeviceGray" if ph["comps"] == 1 else "/DeviceRGB", "data": ph["data"]}
            return {"w": ph["w"], "h": ph["h"], "flt": "/FlateDecode", "cs": "/DeviceRGB",
                    "data": zlib.compress(ph["data"], 6)}
        return f

    streams = []
    for prims in pages:
        ops, used = [], []

        def place(key, x, y, w, h):
            used.append(key)
            ops.append(f"q {w:.2f} 0 0 {h:.2f} {x:.2f} {PH - y - h:.2f} cm /Im{order.index(key)} Do Q")

        for p in prims:
            k = p[0]
            if k == "rect":
                _, x, y, w, h, fill, stroke, lw = p
                if fill:
                    ops.append("%.3f %.3f %.3f rg" % tuple(c / 255 for c in hex_rgb(fill)))
                if stroke:
                    ops.append("%.3f %.3f %.3f RG %.2f w" % (*[c / 255 for c in hex_rgb(stroke)], lw))
                op = "B" if fill and stroke else "f" if fill else "S" if stroke else "n"
                ops.append(f"{x:.2f} {PH - y - h:.2f} {w:.2f} {h:.2f} re {op}")
            elif k == "text":
                _, x, y, s, size, bold, color, al = p
                tw_ = text_w(s, size, bold)
                x = x - tw_ / 2 if al == "c" else x - tw_ if al == "r" else x
                ops.append("BT /F%d %.2f Tf %.3f %.3f %.3f rg %.2f %.2f Td (%s) Tj ET" % (
                    2 if bold else 1, size, *[c / 255 for c in hex_rgb(color)], x, PH - y - size * 0.9, _pdf_esc(s)))
            elif k == "line":
                _, x1, y1, x2, y2, color, lw = p
                ops.append("%.3f %.3f %.3f RG %.2f w %.2f %.2f m %.2f %.2f l S" % (
                    *[c / 255 for c in hex_rgb(color)], lw, x1, PH - y1, x2, PH - y2))
            elif k == "logo":
                _, x, y, w, h, key = p
                im = img_obj("logo:" + key, logo_loader(key))
                bx, by, bw, bh = fit_box(im["w"], im["h"], x, y, w, h, 0)
                if key == "chugg":  # keep it flush with the right edge of its box
                    bx = x + w - bw
                place("logo:" + key, bx, by, bw, bh)
            elif k == "photo":
                _, x, y, w, h, pth = p
                im = img_obj("photo:" + pth, photo_loader(pth))
                if im:
                    bx, by, bw, bh = fit_box(im["w"], im["h"], x, y, w, h)
                    place("photo:" + pth, bx, by, bw, bh)
                else:
                    s = "PHOTO"
                    ops.append("%.3f %.3f %.3f rg BT /F2 8 Tf %.2f %.2f Td (%s) Tj ET" % (
                        *[c / 255 for c in hex_rgb(SLATE)], x + w / 2 - text_w(s, 8, True) / 2,
                        PH - y - h / 2 - 3, s))
            elif k == "sig":
                _, x, y, w, h, strokes = p
                ops.append("%.3f %.3f %.3f RG 1.1 w 1 J 1 j" % tuple(c / 255 for c in hex_rgb(INK)))
                for st in sig_points(strokes, x, y, w, h):
                    ops.append(f"{st[0][0]:.2f} {PH - st[0][1]:.2f} m " + " ".join(
                        f"{a:.2f} {PH - b:.2f} l" for a, b in st[1:]) + " S")
        streams.append(("\n".join(ops).encode("latin-1"), used))

    objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>",
            3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"}
    img_ids = {}
    nid = 5
    for key in order:
        im = images[key]
        if im is None:
            continue
        img_ids[key] = nid
        objs[nid] = (f"<< /Type /XObject /Subtype /Image /Width {im['w']} /Height {im['h']} /ColorSpace {im['cs']} "
                     f"/BitsPerComponent 8 /Filter {im['flt']} /Length {len(im['data'])} >>\nstream\n").encode() \
            + im["data"] + b"\nendstream"
        nid += 1
    kids = []
    for stream, used in streams:
        pid, cid = nid, nid + 1
        nid += 2
        xo = " ".join(f"/Im{order.index(k)} {img_ids[k]} 0 R" for k in dict.fromkeys(used) if k in img_ids)
        kids.append(f"{pid} 0 R")
        objs[pid] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PW} {PH}] /Resources << /Font << /F1 3 0 R "
                     f"/F2 4 0 R >> /XObject << {xo} >> >> /Contents {cid} 0 R >>").encode()
        objs[cid] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    objs[2] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode()
    out, offs = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), {}
    for n in sorted(objs):
        offs[n] = len(out)
        out += f"{n} 0 obj\n".encode() + objs[n] + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for n in sorted(objs):
        out += f"{offs[n]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    Path(path).write_bytes(bytes(out))


WNS = ('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
       'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
       'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
       'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
       'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"')


def export_docx(r, path):
    media, rels = {}, []   # media: name -> bytes ; rels: (rid, target, type)
    counter = {"img": 0}
    IMG_T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"

    def add_media(data, ext, store):
        counter["img"] += 1
        name = f"image{counter['img']}.{ext}"
        media[name] = data
        rid = f"rId{len(store) + 10}"
        store.append((rid, f"media/{name}", IMG_T))
        return rid, counter["img"]

    def drawing(rid, idn, wpt, hpt):
        cx, cy = int(wpt * 12700), int(hpt * 12700)
        return (f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:docPr id="{idn}" name="Picture {idn}"/><wp:cNvGraphicFramePr>'
                f'<a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic>'
                f'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
                f'<pic:nvPicPr><pic:cNvPr id="{idn}" name="Picture {idn}"/><pic:cNvPicPr/></pic:nvPicPr>'
                f'<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
                f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>'
                f'</wp:inline></w:drawing></w:r>')

    def run(text, bold=False, size=20, color=INK[1:]):
        parts = str(text).split("\n")
        inner = "<w:br/>".join(f'<w:t xml:space="preserve">{xesc(p)}</w:t>' for p in parts)
        return (f'<w:r><w:rPr>{"<w:b/>" if bold else ""}<w:color w:val="{color}"/><w:sz w:val="{size}"/></w:rPr>'
                f'{inner}</w:r>')

    def para(inner, jc="left", before=0, after=0, pbb=False, keep=False):
        return (f'<w:p><w:pPr>{"<w:keepNext/>" if keep else ""}{"<w:pageBreakBefore/>" if pbb else ""}'
                f'<w:spacing w:before="{before}" w:after="{after}"'
                f'{" w:line=\"240\" w:lineRule=\"auto\"" if "<w:drawing>" in inner else ""}/>'
                f'<w:jc w:val="{jc}"/></w:pPr>{inner}</w:p>')

    BORD = lambda sides, sz=8: "".join(f'<w:{s} w:val="single" w:sz="{sz}" w:space="0" w:color="{INK[1:]}"/>' for s in sides)
    NOB = "".join(f'<w:{s} w:val="nil"/>' for s in ("top", "left", "bottom", "right"))

    def cell(w, content, borders=True, fill=None, span=1, valign="top", sides=("top", "left", "bottom", "right")):
        b = BORD(sides) if borders else NOB
        shd = f'<w:shd w:val="clear" w:color="auto" w:fill="{fill}"/>' if fill else ""
        gs = f'<w:gridSpan w:val="{span}"/>' if span > 1 else ""
        return (f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/>{gs}<w:tcBorders>{b}</w:tcBorders>{shd}'
                f'<w:tcMar><w:top w:w="70" w:type="dxa"/><w:left w:w="120" w:type="dxa"/>'
                f'<w:bottom w:w="70" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>'
                f'<w:vAlign w:val="{valign}"/></w:tcPr>{content}</w:tc>')

    def table(rows, widths):
        grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
        return (f'<w:tbl><w:tblPr><w:tblW w:w="{sum(widths)}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>'
                f'<w:tblGrid>{grid}</w:tblGrid>{"".join(rows)}</w:tbl>')

    def tr(cells, height=None):
        h = f'<w:trHeight w:val="{height}" w:hRule="exact"/>' if height else ""
        return f'<w:tr><w:trPr><w:cantSplit/>{h}</w:trPr>{"".join(cells)}</w:tr>'

    body, doc_rels = [], []
    W1, W2, W3 = (c * 20 for c in COLS)
    for pi, spec in enumerate(build_pages(r)):
        first = {"pbb": bool(pi)}
        if spec["title"]:
            body.append(para(run(spec["title"], True, 38), after=100, **first))
            first = {}
            for s in spec["sub"]:
                body.append(para(run(s, False, 20), after=20))
            body.append(para("", after=120))
        rows = []

        def flush():
            if rows:
                body.append(table(rows, (W1, W2, W3)))
                body.append(para("", after=60))
                rows.clear()

        for b in spec["blocks"]:
            k = b[0]
            if k == "row":
                rows.append(tr([cell(W1, para(run(b[1], True), "center")),
                                cell(W2, para(run(b[2], True))), cell(W3, para(run(b[3])))]))
                continue
            if k == "sec":
                rows.append(tr([cell(W1 + W2 + W3, para(run(b[1], True), "center"), fill=GROUND[1:], span=3)]))
                continue
            flush()
            if k == "h":
                body.append(para(run(b[1], True, 25), before=100, after=100, keep=True, **first))
                first = {}
            elif k == "p":
                body.append(para(run(b[1]), after=120))
            elif k == "photos":
                items = b[1]
                if not items:
                    body.append(para(run("No photos added.", False, 20, SLATE[1:])))
                gap = 280
                half = (CW * 20 - gap) // 2
                for i in range(0, len(items), 2):
                    pair = items[i:i + 2]
                    cells, caps = [], []
                    for j in range(2):
                        if j < len(pair):
                            cap, pth = pair[j]
                            ph = load_photo(pth)
                            if ph:
                                data, ext = ((ph["data"], "jpeg") if ph["kind"] == "jpeg"
                                             else (png_encode(ph["w"], ph["h"], ph["data"]), "png"))
                                _, _, bw, bh = fit_box(ph["w"], ph["h"], 0, 0, 240, BOXH)
                                rid, idn = add_media(data, ext, doc_rels)
                                inner = para(drawing(rid, idn + 100, bw, bh), "center")
                            else:
                                inner = para(run("PHOTO", True, 16, SLATE[1:]), "center")
                            cells.append(cell(half, inner, valign="center"))
                            caps.append(cell(half, para(run(cap, False, 17, SLATE[1:])), borders=False))
                        else:
                            cells.append(cell(half, para(""), borders=False))
                            caps.append(cell(half, para(""), borders=False))
                        if j == 0:
                            cells.append(cell(gap, para(""), borders=False))
                            caps.append(cell(gap, para(""), borders=False))
                    body.append(table([tr(cells, BOXH * 20 + 140), tr(caps)], (half, gap, half)))
                    body.append(para("", after=80))
            elif k == "sign":
                wl = 233 * 20
                gap = CW * 20 - wl - (CW - 271) * 20
                wr = (CW - 271) * 20
                labs, sigs, names = [], [], []
                for j, (lab, name, strokes) in enumerate(b[1]):
                    w = wl if j == 0 else wr
                    labs.append(cell(w, para(run(lab, True, 16, SLATE[1:])), borders=False))
                    if strokes:
                        rid, idn = add_media(sig_png(strokes, 466, 72), "png", doc_rels)
                        inner = para(drawing(rid, idn + 100, 233, 36))
                    else:
                        inner = para("")
                    sigs.append(cell(w, inner, valign="bottom", sides=("bottom",)))
                    names.append(cell(w, para(run(name, True, 21)), borders=False))
                    if j == 0:
                        for lst in (labs, sigs, names):
                            lst.append(cell(gap, para(""), borders=False))
                body.append(para("", before=240))
                body.append(table([tr(labs), tr(sigs, 800), tr(names)], (wl, gap, wr)))
        flush()

    # header with the yellow band and both logos
    hdr_rels = []
    ra, ia = add_media(logo_png("avris"), "png", hdr_rels)
    rc, ic = add_media(logo_png("chugg"), "png", hdr_rels)
    avw, avh = LOGO_BOX["avris"][2:]
    chw, chh = LOGO_BOX["chugg"][2:]
    half = 11906 // 2

    def hcell(content, jc, left, right):
        return (f'<w:tc><w:tcPr><w:tcW w:w="{half}" w:type="dxa"/><w:tcBorders>{NOB}</w:tcBorders>'
                f'<w:shd w:val="clear" w:color="auto" w:fill="{GROUND[1:]}"/><w:tcMar><w:left w:w="{left}" w:type="dxa"/>'
                f'<w:right w:w="{right}" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr>'
                f'{para(content, jc)}</w:tc>')

    header = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {WNS}>'
              f'<w:tbl><w:tblPr><w:tblW w:w="11906" w:type="dxa"/><w:tblInd w:w="-920" w:type="dxa"/>'
              f'<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="{half}"/><w:gridCol w:w="{half}"/>'
              f'</w:tblGrid><w:tr><w:trPr><w:trHeight w:val="{BAND * 20}" w:hRule="exact"/></w:trPr>'
              f'{hcell(drawing(ra, ia + 100, avw, avh), "left", 880, 0)}'
              f'{hcell(drawing(rc, ic + 100, chw, chh), "right", 0, 880)}</w:tr></w:tbl>'
              f'<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p></w:hdr>')
    footer = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {WNS}><w:p><w:pPr>'
              f'<w:spacing w:before="0" w:after="0"/></w:pPr>{run(ORG_NAME + " · Page ", False, 16, SLATE[1:])}'
              f'<w:fldSimple w:instr="PAGE">{run("1", False, 16, SLATE[1:])}</w:fldSimple>{run(" of ", False, 16, SLATE[1:])}'
              f'<w:fldSimple w:instr="NUMPAGES">{run("1", False, 16, SLATE[1:])}</w:fldSimple></w:p></w:ftr>')
    doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {WNS}><w:body>' + "".join(body) +
           '<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>'
           '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="2150" w:right="920" w:bottom="1000" w:left="920" '
           'w:header="0" w:footer="420" w:gutter="0"/></w:sectPr></w:body></w:document>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles '
              'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>'
              '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="250" w:lineRule="exact"/></w:pPr></w:pPrDefault>'
              '</w:docDefaults></w:styles>')
    R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rel_xml = lambda items: ('<?xml version="1.0" encoding="UTF-8"?><Relationships '
                             'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                             "".join(f'<Relationship Id="{i}" Type="{t}" Target="{g}"/>' for i, g, t in items) +
                             '</Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
                   '<Default Extension="jpeg" ContentType="image/jpeg"/>'
                   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                   '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
                   '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
                   '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>')
        z.writestr("_rels/.rels", rel_xml([("rId1", "word/document.xml", R + "/officeDocument")]))
        z.writestr("word/document.xml", doc)
        z.writestr("word/styles.xml", styles)
        z.writestr("word/header1.xml", header)
        z.writestr("word/footer1.xml", footer)
        z.writestr("word/_rels/document.xml.rels", rel_xml(
            [("rId1", "styles.xml", R + "/styles"), ("rId2", "header1.xml", R + "/header"),
             ("rId3", "footer1.xml", R + "/footer")] + doc_rels))
        z.writestr("word/_rels/header1.xml.rels", rel_xml(hdr_rels))
        for name, data in media.items():
            z.writestr(f"word/media/{name}", data)


def export_csv(r, path):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["No", "Field", "Value"])
        for pg in build_pages(r):
            for b in pg["blocks"]:
                if b[0] == "row":
                    w.writerow([b[1], b[2], str(b[3]).replace("\n", " | ")])
        w.writerow(["", "Recommendation", " ".join(rec_paragraphs(r))])
        w.writerow(["", "Prepared by", r["prepared_by"]])



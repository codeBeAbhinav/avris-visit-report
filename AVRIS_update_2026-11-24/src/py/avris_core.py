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
INCLUDES = ["Cooked food", "Raw / peelings", "Plate leftovers", "Rice and grains", "Bakery and sweets", "Dairy",
            "Eggshells", "Bones / shells", "Tea / coffee grounds", "Expired / packaged", "Used cooking oil",
            "Flowers / garden waste"]
PEAK_DAYS = ["Weekdays", "Weekends", "Public holidays", "Festival season", "Events / banquets", "Term or exam time"]
SEGREGATED = ["Yes", "Partly", "No"]
PLANT_SIZES = ["CHUGG 75", "CHUGG 150"]
FOLLOWUP = ["Yes", "Maybe", "No"]
LEAD_STATUS = ["New", "Contacted", "Quoted", "Won", "Lost"]
PHOTO_TAGS = ["Plant spot", "Kitchen", "Waste", "Route", "Hour metre", "Other"]
HOUR_TAG = "Hour metre"

# Report types. A report without a type (made before November 2026) is a pre-installation report.
PRE, POST = "Pre-installation", "Post-installation"
REPORT_TYPES = [PRE, POST]
PREFIXES = {PRE: "Avris/CHUGG/S.A/", POST: "Avris/CHUGG/P.I/"}

# Tap-to-pick options (stored as the label shown, so the report prints exactly what was tapped)
DESIGNATIONS = ["Owner", "Manager", "Chef", "Facility manager", "Admin", "Purchase", "Supervisor"]
EXISTING_OPTS = ["Municipal collection", "Private vendor", "Composting on site", "Biogas plant",
                 "Pig farm / animal feed", "Open dumping", "Burning"]
WASTE_HOW_OPTS = ["Weighed on site", "Client-stated", "Counted bins", "Kitchen records"]
ROUTE_OPTS = ["Level", "Ramp", "Steps", "Lift", "Narrow passage", "Trolley possible"]
WHEN_OPTS = ["This week", "Within 2 weeks", "Within a month", "Next quarter"]
INSTALL_LOCATIONS = ["Kitchen backyard", "Basement", "Terrace", "Service area", "Parking area"]
YES_NO = ["Yes", "No"]

# Every step has a key; each report type uses its own list of steps.
STEP_DEFS = {
    "basics": ("Visit basics", "Fill these first. Fields with * are required."),
    "people": ("People met", "Who did you meet? Add everyone useful for follow-up."),
    "site": ("Site type and scale", "What kind of place is it, and how big?"),
    "situation": ("Today's situation", "What is the waste problem now? How is it handled today?"),
    "waste": ("Waste numbers", "Food waste only. Leave out paper and plastic."),
    "profile": ("Waste profile", "What is in the waste? How is it handled in the kitchen?"),
    "space": ("Space and route", "Measure the plant space in feet and the walk from the kitchen in metres."),
    "photos": ("Photos", "Add photos. Tap a tag for each one."),
    "rec": ("Recommendation", "Pick the plant size. The standard text is fixed."),
    "install": ("Installation details", "Which plant is installed, and where?"),
    "hour": ("Hour metre", "Type the reading and take a photo of the meter."),
    "training": ("Training and handover", "Tap Yes or No for each item."),
    "followup": ("Follow-up and remarks", "Is another visit needed?"),
    "check": ("Check and send", "Sign, get the customer to sign, preview, then generate."),
}
PRE_KEYS = ["basics", "people", "site", "situation", "waste", "profile", "space", "photos", "rec", "followup", "check"]
POST_KEYS = ["basics", "people", "install", "hour", "waste", "photos", "training", "followup", "check"]
STEPS = [STEP_DEFS[k] for k in PRE_KEYS]
N_STEPS = len(STEPS)


def rtype(r):
    return POST if r.get("report_type") == POST else PRE


def is_post(r):
    return rtype(r) == POST


def step_keys(r):
    return POST_KEYS if is_post(r) else PRE_KEYS


def steps_for(r):
    """[(title, hint, key)] for this report's type."""
    return [(*STEP_DEFS[k], k) for k in step_keys(r)]

REC_P1 = ("We recommend to install {size} which can process up to {cap} kg of food waste per day. "
          "As the system is modular, additional digesters can be added in the future to "
          "accommodate any increase in food waste generation.")
REC_P2 = ("By installing the CHUGG food waste treatment system, there is no need to store food waste, "
          "ensuring better hygiene and on-site processing. It reduces landfill dependency, waste "
          "transportation, and carbon emissions, aligning with sustainability and ESG objectives.")

# Example amounts pre-filled on a new report. Each one must be changed or confirmed before the report can be
# generated, so an example can never reach a customer by accident. key: (value, label, step key)
EXAMPLES = {
    "site_area": ("25000", "Site area", "site"), "served": ("800", "People served per day", "site"),
    "kitchen_staff": ("25", "Kitchen staff", "site"),
    "waste_kg": ("120", "Waste per day", "waste"), "peak_kg": ("160", "Peak-day waste", "waste"),
    "bulk_kg": ("40", "Waste from bulk generators", "waste"),
    "meals": ("1600", "Meals served per day", "profile"),
    "plant_l": ("20", "Plant space length", "space"), "plant_w": ("12", "Plant space width", "space"),
    "dist": ("35", "Distance from site to kitchen", "space"),
}

# Signature box on the printed report, in points. The screen preview and the stored image use this ratio.
SIG_W, SIG_H = 233, 58
# Photo frame on the printed report, in points (4:3).
PHOTO_W, BOXH = 244, 183
PHOTO_FITS = ("fill", "whole")

WASTE_HOW_LABEL = "How did you get this figure?"
STEP_REQ_MSG = "Some required fields are empty. Go on anyway?"

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
    # Standard AVRIS letterhead (AVRIS_Letter_Head_-_with_ISO_LOGO.docx): ISO 9001 badge (cropped as in the
    # letterhead) and the AVRIS wordmark. Source files: assets/letterhead/.
    "iso_s122":
        "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"
        "E+4w+4whDjuTszE+4whCHHcnZmL/2Q==",
    "avrislh_s122":
        "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",
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


def new_report(existing_count, report_type=PRE):
    today = date.today()
    report_type = POST if report_type == POST else PRE
    return {
        "id": uuid.uuid4().hex, "status": "draft", "lead_status": "New", "step": 0,
        "updated": datetime.now().isoformat(timespec="seconds"),
        "report_type": report_type,
        "report_no": f"{PREFIXES[report_type]}{existing_count + 1:03d}/{fy_label(today)}",
        "customer": "", "visit_date": today.strftime("%d/%m/%Y"), "report_date": today.strftime("%d/%m/%Y"),
        "prev_visit": "", "address": "",
        "people": [{"name": "", "designation": "", "contact": "", "email": ""}],
        "site_type": "", "site_area": "", "served": "", "kitchen_staff": "", "op_days": "",
        "issues": [], "issues_text": "", "existing_pick": [], "existing_system": "",
        "waste_kg": "", "waste_how_pick": "", "waste_how": "",
        "peak_days": [], "peak": "", "peak_kg": "", "bulk": "", "bulk_kg": "",
        "meals": "", "nonveg": "", "includes": [], "segregated": "",
        "plant_l": "", "plant_w": "", "dist": "", "route_pick": [], "route": "", "examples": [],
        # post-installation
        "plant_model": "", "serial_no": "", "install_date": "", "commission_date": "", "install_location": "",
        "hour_reading": "", "prev_reading": "", "prev_reading_date": "", "meter_reset": "",
        "staff_trained": "", "trained_count": "", "manual_handed": "", "safety_brief": "",
        "photos": [], "plant_size": "", "rec_extra": "",
        "followup": "", "followup_when": "", "remarks": "",
        "prepared_by": "", "prepared_sig": [], "prepared_sig_img": "",
        # customer sign-off
        "cust_name": "", "cust_designation": "", "cust_mobile": "", "cust_email": "",
        "cust_sig": [], "cust_sig_img": "",
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
    if is_post(r):
        return r.get("plant_model", "")
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


def parse_date(s):
    try:
        return datetime.strptime(str(s or "").strip(), "%d/%m/%Y").date()
    except ValueError:
        return None


EMAIL_RE = re.compile(r"^[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}$", re.I)


def mobile_digits(s):
    """10-digit Indian mobile number from what was typed (+91, spaces and dashes allowed), or ''."""
    d = re.sub(r"\D", "", str(s or ""))
    if len(d) == 12 and d.startswith("91"):
        d = d[2:]
    elif len(d) == 11 and d.startswith("0"):
        d = d[1:]
    return d if len(d) == 10 and d[0] in "6789" else ""


def hour_photo(r):
    """Index of the hour metre photo in r["photos"], or -1."""
    for i, ph in enumerate(r.get("photos") or []):
        if (ph.get("tag") or "") == HOUR_TAG:
            return i
    return -1


def hour_calc(r):
    """(hours since the last reading, average hours per day) or None for each."""
    cur, prev = num(r.get("hour_reading")), num(r.get("prev_reading"))
    if not str(r.get("hour_reading", "")).strip() or not str(r.get("prev_reading", "")).strip() or cur < prev:
        return None, None
    since = round(cur - prev, 1)
    d0, d1 = parse_date(r.get("prev_reading_date")), parse_date(r.get("visit_date"))
    avg = round(since / (d1 - d0).days, 1) if d0 and d1 and (d1 - d0).days > 0 else None
    return since, avg


def missing(r):
    """Required items still empty, as (label, step index) for this report's own steps."""
    m = []
    keys = step_keys(r)

    def need(ok, label, key):
        if not ok and key in keys:
            m.append((label, keys.index(key)))

    post = is_post(r)
    need(r["report_no"].strip(), "Report no.", "basics")
    need(r["customer"].strip(), "Customer name", "basics")
    need(r["visit_date"].strip(), "Date of visit", "basics")
    need(str(r.get("report_date", "")).strip(), "Report date", "basics")
    vd, rd = parse_date(r["visit_date"]), parse_date(r.get("report_date"))
    if vd and rd and rd < vd:
        need(False, "Report date is before the visit date", "basics")
    need(r["address"].strip(), "Address", "basics")
    p = r["people"][0] if r["people"] else {}
    need(p.get("name", "").strip(), "Person met: name", "people")
    need(p.get("contact", "").strip(), "Person met: contact number", "people")
    if post:
        need(r.get("plant_model"), "Plant model", "install")
        need(str(r.get("serial_no", "")).strip(), "Serial number", "install")
        need(str(r.get("install_date", "")).strip(), "Installation date", "install")
        need(str(r.get("hour_reading", "")).strip(), "Hour metre reading", "hour")
        need(hour_photo(r) >= 0, "Hour metre photo", "hour")
        if (str(r.get("prev_reading", "")).strip() and str(r.get("hour_reading", "")).strip()
                and num(r["hour_reading"]) < num(r["prev_reading"])):
            need(r.get("meter_reset") == "Yes", "Reading is lower than last time: tick Meter reset", "hour")
        need(r.get("staff_trained"), "Staff trained", "training")
        need(r.get("manual_handed"), "Manual handed over", "training")
        need(r.get("safety_brief"), "Safety briefing given", "training")
    else:
        need(r["site_type"], "Type of site", "site")
        need(r["served"].strip(), "People served per day", "site")
        need(r["op_days"], "Operating days per week", "site")
        need(r.get("existing_pick") or r["existing_system"].strip(), "Existing waste disposal system", "situation")
        need(r["meals"].strip(), "Meals served per day", "profile")
        need(r["nonveg"], "Non-veg share of waste", "profile")
        need(r["includes"], "What the waste includes", "profile")
        need(r["segregated"], "Segregated at source", "profile")
        need(r["plant_l"].strip() and r["plant_w"].strip(), "Plant space length and width", "space")
        need(r["dist"].strip(), "Distance from site to kitchen", "space")
    need(r["waste_kg"].strip(), "Waste per day (kg)", "waste")
    need(r.get("waste_how_pick") or r["waste_how"].strip(), "How the waste figure was found", "waste")
    need(r["followup"], "Follow-up visit needed", "followup")
    if followup_open(r):
        need(r["followup_when"].strip(), "Follow-up: when", "followup")
    need(r["prepared_by"].strip(), "Prepared by: name", "check")
    need(r["prepared_sig"] or r.get("prepared_sig_img"), "Prepared by: signature", "check")
    need(str(r.get("cust_name", "")).strip(), "Customer sign-off: name", "check")
    need(str(r.get("cust_designation", "")).strip(), "Customer sign-off: designation", "check")
    need(mobile_digits(r.get("cust_mobile")), "Customer sign-off: 10-digit mobile number", "check")
    need(EMAIL_RE.match(str(r.get("cust_email", "")).strip()), "Customer sign-off: email", "check")
    need(r.get("cust_sig") or r.get("cust_sig_img"), "Customer sign-off: signature", "check")
    for k in r.get("examples") or []:
        if k in EXAMPLES:
            need(False, f"Check the example value: {EXAMPLES[k][1]}", EXAMPLES[k][2])
    m.sort(key=lambda x: x[1])
    return m


# ---------------------------------------------------------------- capitalisation
SMALL_WORDS = {"of", "and", "the", "for", "at", "in", "on", "by", "to", "a", "an", "&"}
WORD_FIELDS = ("customer", "address", "prepared_by", "cust_name")
PEOPLE_WORD_FIELDS = ("name",)
SENTENCE_FIELDS = ("issues_text", "existing_system", "waste_how", "peak", "bulk", "route", "rec_extra",
                   "followup_when", "remarks")


def cap_words(s):
    """Capitalise each lower-case word. Words already holding a capital (ITC, McDonald, iPhone) stay as typed."""
    out, first = [], True
    for tok in re.split(r"(\s+)", s or ""):
        if not tok or tok.isspace():
            out.append(tok)
            continue
        m = re.match(r"^([^A-Za-z0-9]*)([a-z][a-z'\u2019.-]*)(.*)$", tok)
        if m and tok == tok.lower() and not ("@" in tok) and not (not first and m.group(2) in SMALL_WORDS):
            tok = m.group(1) + m.group(2)[0].upper() + m.group(2)[1:] + m.group(3)
        out.append(tok)
        first = False
    return "".join(out)


def cap_sentences(s):
    """Capital letter at the start of each sentence and line, and a capital I on its own."""
    s = re.sub(r"(^|[.!?]\s+|\n\s*)([a-z])", lambda m: m.group(1) + m.group(2).upper(), s or "")
    return re.sub(r"\bi\b(?=[\s'\u2019,.!?]|$)", "I", s)


def tidy_caps(r):
    """Apply the capitalisation rules to a report (on generate). Returns the changed field names."""
    changed = []
    for k in WORD_FIELDS:
        v = cap_words(r.get(k, ""))
        if v != r.get(k, ""):
            r[k] = v
            changed.append(k)
    for k in SENTENCE_FIELDS:
        v = cap_sentences(r.get(k, ""))
        if v != r.get(k, ""):
            r[k] = v
            changed.append(k)
    e = str(r.get("cust_email", "") or "").strip().lower()
    if e != r.get("cust_email", ""):
        r["cust_email"] = e
        changed.append("cust_email")
    ppl = []
    for p in r.get("people") or []:
        q = dict(p)
        for k in PEOPLE_WORD_FIELDS:
            q[k] = cap_words(q.get(k, ""))
        q["email"] = (q.get("email", "") or "").strip().lower()
        ppl.append(q)
    if ppl != (r.get("people") or []):
        r["people"] = ppl
        changed.append("people")
    return changed


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


def pick_line(picks, text, sep=", "):
    """Tapped options, then any typed note."""
    a = sep.join(picks or [])
    t = (text or "").strip()
    return ". ".join(x for x in (a, t) if x)


def route_line(r):
    d = f"{r['dist']} m" if str(r["dist"]).strip() else ""
    return ". ".join(x for x in (d, pick_line(r.get("route_pick"), r.get("route"))) if x) or "—"


def existing_line(r):
    return pick_line(r.get("existing_pick"), r.get("existing_system")) or "—"


def waste_how_line(r):
    return pick_line([r["waste_how_pick"]] if r.get("waste_how_pick") else [], r.get("waste_how"))


def peak_line(r):
    days = ", ".join(r.get("peak_days") or [])
    t = (r.get("peak") or "").strip()
    return ". ".join(x for x in (days, t) if x) or "—"


def bulk_line(r):
    t = (r.get("bulk") or "").strip()
    k = str(r.get("bulk_kg", "")).strip()
    if t and k:
        return f"{t} ({k} kg/day)"
    return t or (f"{k} kg/day" if k else "—")


def photo_label(i, ph):
    """Caption line under a photo: Photo 1 (Kitchen): caption."""
    tag = (ph.get("tag") or "").strip()
    cap = (ph.get("caption") or "").strip()
    head = f"Photo {i + 1}" + (f" ({tag})" if tag else "")
    return f"{head}: {cap}" if cap else head


def followup_line(r):
    if not r["followup"]:
        return "—"
    if r["followup"] == "No":
        return "No"
    return f"{r['followup']} – {r['followup_when'].strip() or '—'}"


def _people_lines(r):
    out = []
    for p in r["people"]:
        bits = [p.get("name", ""), p.get("designation", ""), p.get("contact", ""), p.get("email", "")]
        line = ", ".join(b for b in (x.strip() for x in bits) if b)
        if line:
            out.append(line)
    return out


def _dt(s):
    return fmt_date(s) if str(s or "").strip() else "—"


def _sign_block(r):
    """Prepared by (AVRIS) on the left, the customer's approval on the right."""
    cust_extra = [x for x in (r.get("cust_designation", "").strip(),
                              ("Date: " + fmt_date(r["report_date"])) if str(r.get("report_date", "")).strip() else "") if x]
    return ("sign", [("PREPARED BY (AVRIS)", r["prepared_by"].strip(), r["prepared_sig"], r.get("prepared_sig_img", ""), []),
                     ("APPROVED BY CUSTOMER", r.get("cust_name", "").strip(), r.get("cust_sig") or [], r.get("cust_sig_img", ""), cust_extra)])


def _number(pages):
    """Rows are numbered in order across all pages."""
    n = 0
    for pg in pages:
        out = []
        for b in pg["blocks"]:
            if b[0] == "row":
                n += 1
                b = ("row", n, b[1], b[2])
            out.append(b)
        pg["blocks"] = out
    return pages


def _waste_blocks(r, size, cap):
    kg = num(r["waste_kg"])
    how = waste_how_line(r)
    pk = num(r.get("peak_kg", ""))
    bk = num(r.get("bulk_kg", ""))
    return [
        ("row", "Waste per day in kgs (excluding paper/plastics)",
         (f"{r['waste_kg']} kg" + (f" – {how}" if how else "")) if r["waste_kg"] else "—"),
        ("row", "Peak days or times", peak_line(r)),
        ("row", "Peak-day waste", f"{r['peak_kg']} kg/day" if str(r.get("peak_kg", "")).strip() else "—"),
        ("row", "Bulk generators", bulk_line(r)),
    ], [
        ("row", "Plant utilisation (average day)",
         f"{round(kg / cap * 100)}% of {size} capacity ({r['waste_kg']} of {cap} kg/day)" if kg and cap else "—"),
        ("row", "Plant utilisation (peak day)",
         f"{round(pk / cap * 100)}% of {size} capacity ({r['peak_kg']} of {cap} kg/day)" if pk and cap else "—"),
        ("row", "Share from bulk generators",
         f"{round(bk / kg * 100)}% of daily waste ({r['bulk_kg']} of {r['waste_kg']} kg)" if bk and kg else "—"),
    ]


def _photo_items(r):
    return [(photo_label(i, ph), ph.get("path", ""), ph.get("fit") if ph.get("fit") in PHOTO_FITS else "fill")
            for i, ph in enumerate(r["photos"])]


def build_pages(r, view="team"):
    """The logical report pages, shared by the preview, PDF, Word and CSV export.
    view "customer" is the copy sent to the customer: internal remarks are left out."""
    if is_post(r):
        return _number(_post_pages(r, view))
    no, cust = r["report_no"], r["customer"]
    people = _people_lines(r)
    size = effective_size(r)
    cap = size_cap(size)
    kg, meals = num(r["waste_kg"]), num(r["meals"])
    per_meal = f"{round(kg * 1000 / meals)} g per meal" if kg and meals else "—"
    space = f"{r['plant_l']} × {r['plant_w']} ft" if r["plant_l"] and r["plant_w"] else "—"
    remarks = dash(r["remarks"]) if followup_open(r) else "—"
    waste_rows, calc_rows = _waste_blocks(r, size, cap)

    p1 = {"title": "Pre-installation Visit Report – CHUGG",
          "sub": [f"S.No: {no}    Visit: {fmt_date(r['visit_date'])}    Report: {_dt(r.get('report_date'))}", f"Name: {cust}"],
          "blocks": [
              ("row", "Date/s of Visit/Tour", fmt_date(r["visit_date"])),
              ("row", "Date of report", _dt(r.get("report_date"))),
              ("row", "Date of previous visit", fmt_date(r["prev_visit"]) if r["prev_visit"].strip() else "None"),
              ("row", "Customer Name", dash(cust)),
              ("row", "Address", dash(r["address"])),
              ("row", "Persons met with designation, contact and email", "\n".join(people) or "—"),
              ("row", "Present issues in waste disposal", issues_line(r)),
              ("row", "Existing waste disposal system", existing_line(r)),
              waste_rows[0],
              ("row", "Space availability for installation of CHUGG Plant (in feet)", space),
              ("row", "CHUGG plant size recommended", dash(size)),
              ("row", "Distance from site to kitchen (in meters)", route_line(r)),
              ("row", "Follow up visit required / when", followup_line(r)),
          ] + ([] if view == "customer" else [("row", "Remarks", remarks)])}
    p2 = {"title": "Site and waste profile",
          "sub": [f"Customer: {cust}     Report no. {no}"],
          "blocks": [
              ("sec", "Site type and scale"),
              ("row", "Type of site", dash(r["site_type"])),
              ("row", "Site area", f"{r['site_area']} sq ft" if r["site_area"] else "—"),
              ("row", "People served per day", dash(r["served"])),
              ("row", "Kitchen staff", dash(r["kitchen_staff"])),
              ("row", "Operating days per week", r["op_days"].split()[0] if r["op_days"] else "—"),
              ("sec", "Waste numbers"), *waste_rows[1:],
              ("sec", "Waste profile"),
              ("row", "Meals served per day", dash(r["meals"])),
              ("row", "Non-veg share of waste", dash(r["nonveg"])),
              ("row", "Waste includes", ", ".join(r["includes"]) or "—"),
              ("row", "Segregated at source", dash(r["segregated"])),
              ("sec", "Calculated"),
              ("row", "Waste per meal", per_meal), *calc_rows,
          ]}
    p3 = {"title": None, "sub": [],
          "blocks": [("h", "Photographs"), ("photos", _photo_items(r)), ("h", "Recommendation")]
                    + [("p", t) for t in rec_paragraphs(r)] + [_sign_block(r)]}
    return _number([p1, p2, p3])


def _post_pages(r, view):
    no, cust = r["report_no"], r["customer"]
    size = effective_size(r)
    cap = size_cap(size)
    since, avg = hour_calc(r)
    hp = hour_photo(r)
    remarks = dash(r["remarks"]) if followup_open(r) else "—"
    waste_rows, calc_rows = _waste_blocks(r, size, cap)
    reading = f"{r['hour_reading']} hrs" if str(r.get("hour_reading", "")).strip() else "—"
    if hp >= 0:
        reading += f" (see Photo {hp + 1})"
    prev = "—"
    if str(r.get("prev_reading", "")).strip():
        prev = f"{r['prev_reading']} hrs" + (f" on {fmt_date(r['prev_reading_date'])}" if str(r.get("prev_reading_date", "")).strip() else "")
    if r.get("meter_reset") == "Yes":
        prev += ". Meter was reset or replaced"
    tc = str(r.get("trained_count", "")).strip()
    p1 = {"title": "Post-installation Visit Report – CHUGG",
          "sub": [f"S.No: {no}    Visit: {fmt_date(r['visit_date'])}    Report: {_dt(r.get('report_date'))}", f"Name: {cust}"],
          "blocks": [
              ("row", "Date/s of Visit", fmt_date(r["visit_date"])),
              ("row", "Date of report", _dt(r.get("report_date"))),
              ("row", "Date of previous visit", fmt_date(r["prev_visit"]) if r["prev_visit"].strip() else "None"),
              ("row", "Customer Name", dash(cust)),
              ("row", "Address", dash(r["address"])),
              ("row", "Persons met with designation, contact and email", "\n".join(_people_lines(r)) or "—"),
              ("sec", "Installation"),
              ("row", "CHUGG plant model", dash(r.get("plant_model", ""))),
              ("row", "Serial number", dash(r.get("serial_no", ""))),
              ("row", "Installation date", _dt(r.get("install_date"))),
              ("row", "Commissioning date", _dt(r.get("commission_date"))),
              ("row", "Installed location on site", dash(r.get("install_location", ""))),
              ("sec", "Hour metre"),
              ("row", "Hour metre reading", reading),
              ("row", "Previous reading", prev),
              ("row", "Running hours since last reading", f"{since:g} hrs" if since is not None else "—"),
              ("row", "Average running hours per day", f"{avg:g} hrs/day" if avg is not None else "—"),
          ]}
    p2 = {"title": "Waste, training and follow-up",
          "sub": [f"Customer: {cust}     Report no. {no}"],
          "blocks": [("sec", "Waste numbers"), *waste_rows, *calc_rows,
                     ("sec", "Training and handover"),
                     ("row", "Staff trained", dash(r.get("staff_trained", "")) + (f" ({tc} people)" if tc and r.get("staff_trained") == "Yes" else "")),
                     ("row", "Operating manual handed over", dash(r.get("manual_handed", ""))),
                     ("row", "Safety briefing given", dash(r.get("safety_brief", ""))),
                     ("sec", "Follow-up"),
                     ("row", "Follow up visit required / when", followup_line(r))]
                    + ([] if view == "customer" else [("row", "Remarks", remarks)])}
    p3 = {"title": None, "sub": [], "blocks": [("h", "Photographs"), ("photos", _photo_items(r)), _sign_block(r)]}
    return [p1, p2, p3]


# ---------------------------------------------------------------- A4 layout (points, y from the top)
PW, PH = 595, 842
MX, CW = 46, 502                  # left margin, content width
BAND = 80                         # letterhead area at the top of each page
COLS = (28, 176, 298)             # No. | field | value
LIMIT = PH - 52                   # content must end above the footer
LOGO_BOX = {"avris": (43.5, 15.5, 140.5, 46.0), "chugg": (429.0, 20.5, 122.5, 34.5)}

# ---------------------------------------------------------------- standard letterhead
# Content is taken word for word from the AVRIS letterhead; only spacing and alignment are tidied.
LH_NAME = "AVRIS ENVIRONMENT TECHNOLOGIES PVT LTD"
LH_LINES = ["1st Floor # 15 1st Avenue Indira Nagar, Adyar Chennai 600020",
            "Mobile: +919600518972; +919629818972",
            "Email: bharath@avristech.com; ravi@avristech.com"]
LH_EMAILS = ["bharath@avristech.com", "ravi@avristech.com"]
LH_ISO = (MX, 15.0, 86.0, 46.0)                  # ISO 9001 badge, left (374 x 200 px)
LH_AVRIS = (PW - MX - 100.0, 25.3, 100.0, 25.4)   # AVRIS wordmark, right (201 x 51 px)
LH_RULE_Y = 70.0                                  # heavy rule under the letterhead
LH_TEXT_X = (LH_ISO[0] + LH_ISO[2] + LH_AVRIS[0]) / 2   # centre of the gap between the two logos
FOOT_RULE = "#d9d9d9"
FOOT_GREY = "#808080"


def letterhead_prims():
    """Drawing primitives for the letterhead at the top of every page."""
    out = [("logo", *LH_ISO, "iso"), ("logo", *LH_AVRIS, "avrislh"),
           ("text", LH_TEXT_X, 17, LH_NAME, 12, True, INK, "c")]
    for i, t in enumerate(LH_LINES):
        out.append(("text", LH_TEXT_X, 34 + i * 11, t, 8.5, False, INK, "c"))
    out.append(("line", MX, LH_RULE_Y, MX + CW, LH_RULE_Y, INK, 1.4))
    return out


def letterhead_footer(n):
    """Letterhead page footer: light rule, then "<n> | Page" flush right."""
    right = MX + CW
    return [("line", MX, 800, right, 800, FOOT_RULE, 0.5),
            ("text", right, 805, "Page", 9, False, FOOT_GREY, "r"),
            ("text", right - text_w("Page", 9) - 1, 805, f"{n} | ", 9, True, INK, "r")]

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


def layout_report(r, view="team"):
    """Turn the logical pages into drawing primitives for each physical A4 page."""
    pages, st = [], {}

    def new_page(first_y=BAND + 14):
        cur = letterhead_prims()
        pages.append(cur)
        st["cur"], st["y"] = cur, first_y

    def ensure(h):
        if st["y"] + h > LIMIT:
            new_page()

    def add(p):
        st["cur"].append(p)

    for spec in build_pages(r, view):
        new_page()
        if spec["title"]:
            add(("text", MX, BAND + 14, spec["title"], 19, True, INK, "l"))
            y = BAND + 39
            for s in spec["sub"]:
                add(("text", MX, y, s, 10, False, INK, "l"))
                y += 12
            st["y"] = y + 10
        else:
            st["y"] = BAND + 12
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
                    caps = [wrap(c, PHOTO_W, 8.5) for c, _, _ in pair]   # captions wrap in full, never cut
                    rowh = BOXH + 5 + max(len(c) for c in caps) * 10.5 + 12
                    ensure(rowh)
                    for j, (cap, path, fit) in enumerate(pair):
                        x = MX + j * (PHOTO_W + 14)
                        add(("rect", x, st["y"], PHOTO_W, BOXH, CARD, INK, 0.8))
                        add(("photo", x, st["y"], PHOTO_W, BOXH, path, fit))
                        add(("rect", x, st["y"], PHOTO_W, BOXH, None, INK, 0.8))   # keyline on top of a filled photo
                        for q, t in enumerate(caps[j]):
                            add(("text", x, st["y"] + BOXH + 5 + q * 10.5, t, 8.5, False, SLATE, "l"))
                    st["y"] += rowh
            elif k == "sign":
                yb = max(st["y"] + 24, 690)
                if yb + SIG_H + 50 > PH - 44:
                    new_page()
                    yb = st["y"] + 24
                for j, (lab, name, strokes, img, extra) in enumerate(b[1]):
                    x = MX if j == 0 else MX + 271
                    wline = SIG_W if j == 0 else CW - 271
                    add(("text", x, yb, lab, 8, True, SLATE, "l"))
                    if img:   # the stored image already has the box's exact proportions
                        add(("sigimg", x, yb + 10, SIG_W, SIG_H, img, "cust" if j else "prepared"))
                    elif strokes:
                        add(("sig", x, yb + 10, wline, SIG_H, strokes))
                    add(("line", x, yb + SIG_H + 12, x + wline, yb + SIG_H + 12, INK, 0.8))
                    if name:
                        add(("text", x, yb + SIG_H + 17, name, 10.5, True, INK, "l"))
                    for q, t in enumerate(extra):
                        add(("text", x, yb + SIG_H + 31 + q * 12, t, 9, False, SLATE, "l"))
    for i, pg in enumerate(pages):
        pg.extend(letterhead_footer(i + 1))
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


def cover_box(iw, ih, x, y, w, h):
    """Smallest iw:ih rectangle that covers the box, centred (the parts outside are clipped)."""
    s = max(w / iw, h / ih)
    return x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s


def cover_crop(iw, ih, w, h):
    """Share of the image cut from each side (l, t, r, b, 0..1) when it fills a w:h box."""
    if iw / ih > w / h:
        k = (1 - (w / h) / (iw / ih)) / 2
        return k, 0.0, k, 0.0
    k = (1 - (iw / ih) / (w / h)) / 2
    return 0.0, k, 0.0, k


def sig_img_bytes(data_url):
    """PNG bytes from the stored signature (a data: URL), or None."""
    m = re.match(r"^data:image/png;base64,([A-Za-z0-9+/=]+)$", data_url or "")
    if not m:
        return None
    try:
        b = base64.b64decode(m.group(1))
    except Exception:
        return None
    return b if b[:8] == b"\x89PNG\r\n\x1a\n" else None


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


def _sig_pdf_img(data_url):
    b = sig_img_bytes(data_url)
    if not b:
        return None
    try:
        w, h, rgb = png_decode(b, (255, 255, 255))
    except Exception:
        return None
    return {"w": w, "h": h, "flt": "/FlateDecode", "cs": "/DeviceRGB", "data": zlib.compress(rgb, 6)}


def export_pdf(r, path, view="team"):
    pages = layout_report(r, view)
    images, order = {}, []   # key -> object number placeholder data

    def img_obj(key, loader):
        if key not in images:
            images[key] = loader()
            order.append(key)
        return images[key]

    def logo_loader(key):
        def f():
            data = logo_png(key)
            if data[:2] == b"\xff\xd8":   # JPEG (the ISO badge): embedded as is
                w, h, comps = jpeg_info(data)
                return {"w": w, "h": h, "flt": "/DCTDecode", "cs": "/DeviceGray" if comps == 1 else "/DeviceRGB",
                        "data": data}
            w, h, rgb = png_decode(data, (255, 255, 255))
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

        def place(key, x, y, w, h, clip=None):
            used.append(key)
            c = ""
            if clip:
                cx, cy, cw, ch = clip
                c = f"{cx:.2f} {PH - cy - ch:.2f} {cw:.2f} {ch:.2f} re W n "
            ops.append(f"q {c}{w:.2f} 0 0 {h:.2f} {x:.2f} {PH - y - h:.2f} cm /Im{order.index(key)} Do Q")

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
            elif k == "sigimg":
                _, x, y, w, h, data = p[:6]
                skey = "sig:" + (p[6] if len(p) > 6 else "prepared")
                im = img_obj(skey, lambda: _sig_pdf_img(data))
                if im:
                    place(skey, x, y, w, h)
            elif k == "photo":
                _, x, y, w, h, pth, fit = (*p, "fill")[:7]
                im = img_obj("photo:" + pth, photo_loader(pth))
                if im and fit == "fill":
                    bx, by, bw, bh = cover_box(im["w"], im["h"], x, y, w, h)
                    place("photo:" + pth, bx, by, bw, bh, clip=(x, y, w, h))
                elif im:
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


def export_docx(r, path, view="team"):
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

    def drawing(rid, idn, wpt, hpt, crop=None):
        cx, cy = int(wpt * 12700), int(hpt * 12700)
        src = ""
        if crop and any(crop):
            src = '<a:srcRect l="%d" t="%d" r="%d" b="%d"/>' % tuple(int(round(v * 100000)) for v in crop)
        return (f'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
                f'<wp:docPr id="{idn}" name="Picture {idn}"/><wp:cNvGraphicFramePr>'
                f'<a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic>'
                f'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
                f'<pic:nvPicPr><pic:cNvPr id="{idn}" name="Picture {idn}"/><pic:cNvPicPr/></pic:nvPicPr>'
                f'<pic:blipFill><a:blip r:embed="{rid}"/>{src}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
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
    for pi, spec in enumerate(build_pages(r, view)):
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
                            cap, pth, fit = pair[j]
                            ph = load_photo(pth)
                            fw, fh = 232, 174                     # frame inside the cell, 4:3 like the PDF
                            if ph:
                                data, ext = ((ph["data"], "jpeg") if ph["kind"] == "jpeg"
                                             else (png_encode(ph["w"], ph["h"], ph["data"]), "png"))
                                rid, idn = add_media(data, ext, doc_rels)
                                if fit == "fill":
                                    inner = para(drawing(rid, idn + 100, fw, fh, cover_crop(ph["w"], ph["h"], fw, fh)), "center")
                                else:
                                    _, _, bw, bh = fit_box(ph["w"], ph["h"], 0, 0, fw, fh, 0)
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
                    body.append(table([tr(cells, 174 * 20 + 200), tr(caps)], (half, gap, half)))
                    body.append(para("", after=80))
            elif k == "sign":
                wl = 233 * 20
                gap = CW * 20 - wl - (CW - 271) * 20
                wr = (CW - 271) * 20
                labs, sigs, names = [], [], []
                extras = []
                for j, (lab, name, strokes, img, extra) in enumerate(b[1]):
                    w = wl if j == 0 else wr
                    labs.append(cell(w, para(run(lab, True, 16, SLATE[1:])), borders=False))
                    sb = sig_img_bytes(img) if img else None
                    if sb:
                        rid, idn = add_media(sb, "png", doc_rels)
                        inner = para(drawing(rid, idn + 100, 221, 221 * SIG_H / SIG_W))
                    elif strokes:
                        rid, idn = add_media(sig_png(strokes, 466, 116), "png", doc_rels)
                        inner = para(drawing(rid, idn + 100, 221, 221 * SIG_H / SIG_W))
                    else:
                        inner = para("")
                    sigs.append(cell(w, inner, valign="bottom", sides=("bottom",)))
                    names.append(cell(w, para(run(name, True, 21)), borders=False))
                    extras.append(cell(w, "".join(para(run(t, False, 18, SLATE[1:])) for t in extra) or para(""), borders=False))
                    if j == 0:
                        for lst in (labs, sigs, names, extras):
                            lst.append(cell(gap, para(""), borders=False))
                body.append(para("", before=240))
                body.append(table([tr(labs), tr(sigs, SIG_H * 20 + 260), tr(names), tr(extras)], (wl, gap, wr)))
        flush()

    # header: the standard AVRIS letterhead (ISO badge | name and contacts | AVRIS wordmark, heavy rule below)
    hdr_rels = []
    ri, ii = add_media(logo_png("iso"), "jpeg", hdr_rels)
    rv, iv = add_media(logo_png("avrislh"), "png", hdr_rels)
    LINK_T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
    mail_ids = []
    for k, addr in enumerate(LH_EMAILS):
        rid = f"rIdM{k + 1}"
        hdr_rels.append((rid, f"mailto:{addr}", LINK_T))
        mail_ids.append(rid)
    total_w = CW * 20
    wl, wr = 1900, 2100
    wc = total_w - wl - wr

    def hc(w, content):
        return (f'<w:tc><w:tcPr><w:tcW w:w="{w}" w:type="dxa"/><w:tcBorders>{NOB}</w:tcBorders>'
                f'<w:tcMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>'
                f'<w:vAlign w:val="center"/></w:tcPr>{content}</w:tc>')

    def hp(inner, jc="center", after=0):
        return (f'<w:p><w:pPr><w:spacing w:before="0" w:after="{after}" w:line="220" w:lineRule="exact"/>'
                f'<w:jc w:val="{jc}"/></w:pPr>{inner}</w:p>')

    def link(rid, text):
        return f'<w:hyperlink r:id="{rid}">{run(text, False, 17)}</w:hyperlink>'

    email_line = run("Email: ", False, 17) + link(mail_ids[0], LH_EMAILS[0]) + run("; ", False, 17) + link(mail_ids[1], LH_EMAILS[1])
    centre = (f'<w:p><w:pPr><w:spacing w:before="0" w:after="40"/><w:jc w:val="center"/></w:pPr>'
              f'{run(LH_NAME, True, 24)}</w:p>'
              + hp(run(LH_LINES[0], False, 17)) + hp(run(LH_LINES[1], False, 17)) + hp(email_line))
    header = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr {WNS}>'
              f'<w:tbl><w:tblPr><w:tblW w:w="{total_w}" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
              f'<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>'
              f'<w:tblGrid><w:gridCol w:w="{wl}"/><w:gridCol w:w="{wc}"/><w:gridCol w:w="{wr}"/></w:tblGrid><w:tr>'
              f'{hc(wl, para(drawing(ri, ii + 100, LH_ISO[2], LH_ISO[3]), "left"))}'
              f'{hc(wc, centre)}'
              f'{hc(wr, para(drawing(rv, iv + 100, LH_AVRIS[2], LH_AVRIS[3]), "right"))}</w:tr></w:tbl>'
              f'<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="{INK[1:]}"/></w:pBdr>'
              f'<w:spacing w:before="0" w:after="0" w:line="80" w:lineRule="exact"/></w:pPr></w:p></w:hdr>')
    grey = (f'<w:r><w:rPr><w:color w:val="{FOOT_GREY[1:]}"/><w:spacing w:val="60"/><w:sz w:val="18"/></w:rPr>'
            f'<w:t>Page</w:t></w:r>')
    footer = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr {WNS}><w:p><w:pPr>'
              f'<w:pBdr><w:top w:val="single" w:sz="4" w:space="1" w:color="{FOOT_RULE[1:]}"/></w:pBdr>'
              f'<w:spacing w:before="0" w:after="0"/><w:jc w:val="right"/></w:pPr>'
              f'<w:fldSimple w:instr="PAGE">{run("1", True, 18)}</w:fldSimple>{run(" | ", True, 18)}{grey}</w:p></w:ftr>')
    doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {WNS}><w:body>' + "".join(body) +
           '<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>'
           '<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1880" w:right="920" w:bottom="1000" w:left="920" '
           'w:header="280" w:footer="420" w:gutter="0"/></w:sectPr></w:body></w:document>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles '
              'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>'
              '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="20"/></w:rPr></w:rPrDefault>'
              '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="250" w:lineRule="exact"/></w:pPr></w:pPrDefault>'
              '</w:docDefaults></w:styles>')
    R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rel_xml = lambda items: ('<?xml version="1.0" encoding="UTF-8"?><Relationships '
                             'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                             "".join(f'<Relationship Id="{i}" Type="{t}" Target="{xesc(g)}"'
                                     f'{" TargetMode=\"External\"" if g.startswith("mailto:") else ""}/>'
                                     for i, g, t in items) +
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


def export_csv(r, path, view="team"):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["No", "Field", "Value"])
        for pg in build_pages(r, view):
            for b in pg["blocks"]:
                if b[0] == "row":
                    w.writerow([b[1], b[2], str(b[3]).replace("\n", " | ")])
        w.writerow(["", "Report type", rtype(r)])
        if not is_post(r):
            w.writerow(["", "Recommendation", " ".join(rec_paragraphs(r))])
        w.writerow(["", "Prepared by", r["prepared_by"]])
        w.writerow(["", "Approved by customer", r.get("cust_name", "")])
        w.writerow(["", "Customer designation", r.get("cust_designation", "")])
        w.writerow(["", "Customer mobile", r.get("cust_mobile", "")])
        w.writerow(["", "Customer email", r.get("cust_email", "")])



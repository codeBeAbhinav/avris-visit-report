# AVRIS Visit Report: one HTML file

`dist/AVRIS_Visit_Report.html` (copied to `index.html` for hosting) is the whole tool in a single file: the screens, the report engine (`avris_visit_report_v2.py` logic) and the Python runtime (Pyodide). Double-click it to open it in Chrome, Edge, Firefox or Safari. It needs no server or installation. Generate and Email use the internet to reach the AVRIS Google register; everything else works offline.

## Use

1. Open the file. The first start takes a few seconds while the Python engine wakes up.
2. Fill in the 11 steps. Everything saves as you type.
3. Generate report, then download: PDF, Word, CSV, or All files (one ZIP with all three). Completed reports can also be downloaded together as one CSV or a ZIP of PDFs.
4. Settings (tap your name on Home): download a backup of every report and photo, and restore it later or on another device.

## Where reports are kept

Open the file in a normal browser window (Chrome, Edge, Firefox, Safari), not inside a preview pane of another app. Some preview panes block the browser storage. The tool still works there, but reports are kept only until the window closes, and it says so.

In the browser on the device that created them. Keep the HTML file in one place and open it from there. Clearing browser data, or opening it in a private window, loses the reports, so download a backup now and then.

## Rebuild the file

```
python3 build.py
```

This reads `src/` and `vendor/pyodide/` and writes `dist/AVRIS_Visit_Report.html`.

- `src/app.js`, `app.css`, `index.template.html`: the screens.
- `src/local.js`: storage in the browser and the Python engine start-up.
- `src/py/avris_core.py`: report rules, layout, PDF, Word and CSV builders (from the desktop tool).
- `src/py/engine.py`: connects the screens to the engine.
- `vendor/pyodide/`: the Python runtime (Pyodide 314.0.7).
- `future-server/`: the earlier shared-server version, not used now.

## Hosting

The same file works on any static host. On Netlify, drag it in renamed to `index.html`.

## Google Drive and Sheets (numbering and filing)

`cloud/Code.gs` is a Google Apps Script. Set it up with `cloud/SETUP.md`, then connect each device in Settings, Google Drive. Generate then issues the next report number from one shared counter, files the PDF, Word, CSV, report data and photos in Drive, and adds a row to the register Sheet. Without a connection the tool numbers reports on the device as before.

Tests: the script was run against an in-memory stand-in for Drive and Sheets (numbering, retries, financial-year rollover, filing, void). Check one real report after setup.

## Letterhead

Every page of the PDF, Word file and preview carries the standard AVRIS letterhead (`assets/letterhead/AVRIS_Letter_Head_with_ISO_LOGO.docx`): ISO 9001 badge on the left, company name, address, mobile and email in the centre, the AVRIS wordmark on the right, a heavy rule below, and the "1 | Page" footer. The text is in `LH_NAME` and `LH_LINES` in `src/py/avris_core.py`; the two images are embedded there as `iso_s122` and `avrislh_s122`.

## Email to AVRIS team

On a generated report, **Email to AVRIS team** sends a ready-made email through the Google script: subject `Site visit report | Customer | Report no. | Date`, a short summary of the visit, an optional note, and the report attached as PDF and Word. It can go to any address (`ALLOW_ANY_RECIPIENT` in `cloud/Code.gs`). The usual recipients are set once per device in Settings. The script needs a one-time update for this: `cloud/SETUP.md`, step 5.

## Motion and pop-ups

Screens slide forward and back between steps and fade in elsewhere, and their content cascades in. Confirmations, the "Report generated" and "Email sent" messages, and photo previews open as pop-ups. Step 11 and every completed report show a **Report overview**: a completion ring, an 11-section tracker (tap a section to jump to it), metric tiles that count up, a plant-utilisation bar, issue and follow-up tags, and a photo strip that opens a lightbox. Code: `reportOverview`, `modal` and `navDir` in `src/app.js`; styles in the "motion" part of `src/app.css`. While the engine starts, and while a report saves to Google Drive, an animated loading scene plays: food scraps drop into a digester, it fills, a sprout grows, with a progress sweep and rotating status messages (`loaderScene` in `src/app.js`). Everything switches off when the device is set to reduce motion.

## Screen sizes

The tool adapts to the screen, upright or sideways:

- Phone (under 700 px wide): one column, as before. Held sideways, the header and buttons get tighter so more of the form shows.
- Tablet and large phones sideways (700 px and up): wider page, reports as a two-column card grid, footer buttons sized to their text.
- 900 px and up: a completed report splits into two columns, the overview and details on the left and status, downloads and email on the right.
- Laptop (1024 px and up): while filling a report, a side column lists all 11 sections with their state; click one to jump to it. On Check and send, the side column shows the report overview.

The breakpoints are in the "responsive layout" part of `src/app.css`; the side column is `stepNav` in `src/app.js`.

## Built-in Google connection

`src/cloud.js` holds the register's web app URL and access key (`AVRIS_CLOUD_DEFAULT`), so every copy of the tool is connected without set-up. A device can still save its own in Settings. Because the key is readable in the file, share the HTML only inside AVRIS.

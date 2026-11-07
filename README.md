# AVRIS Visit Report: one HTML file

`dist/AVRIS_Visit_Report.html` is the whole tool in a single file: the screens, the report engine (`avris_visit_report_v2.py` logic) and the Python runtime (Pyodide). Double-click it to open it in Chrome, Edge, Firefox or Safari. It needs no server, no internet and no installation, and it never sends data anywhere.

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

## Next step: email

Email cannot be sent from a page with no server. Options for later: open the mail app with a prefilled message (the PDF is attached by hand or via Share on a phone), or add a small server or email service.

# Connect the AVRIS Visit Report tool to Google Drive and Sheets

Do this once, signed in to the Google account that should own the records (workinprogresss69@gmail.com).
It takes about five minutes. After it, every generated report gets the next number and is filed automatically.

## 1. Add the script

1. Open script.google.com and choose **New project**.
2. Delete the sample code. Open `AVRIS_Register_Code.gs`, copy everything and paste it in.
3. Press **Save** (disk icon). Name the project "AVRIS Register".

## 2. Create the folder and register, and give permission

1. In the toolbar pick the function **setup** and press **Run**.
2. Choose **Review permissions** and pick your account.
3. Google says "Google hasn't verified this app". This is your own script. Choose **Advanced**, then **Go to AVRIS Register (unsafe)**, then **Allow**.
4. Check My Drive: a folder **AVRIS Visit Reports** now exists with a Sheet **AVRIS Visit Report Register** inside it.

## 3. Publish it as a web app

1. Choose **Deploy**, then **New deployment**. Click the gear and pick **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. Choose **Deploy**.
3. Copy the **Web app URL**. It ends in `/exec`.

## 4. Connect the tool (on every phone or computer that creates reports)

1. Open `AVRIS_Visit_Report.html`, tap your name on Home to open Settings.
2. Under **Google Drive** paste the Web app URL and the access key. The key is the value of the `ACCESS_KEY` line near the top of the script.
3. Tap **Save and test**. You should see "Connected to Google Drive".

## What happens at Generate

- The report gets the next number from one shared counter, for example `Avris/CHUGG/S.A/014/26-27`. The count restarts at 001 on 1 April.
- Drive: `AVRIS Visit Reports / 26-27 / 014 - Customer Name /` holds the PDF, Word file, CSV, `report data.json` and a `Photos` folder.
- The Sheet **Reports** tab gets one row per report with a link to the folder and the PDF. The **Numbers** tab logs every number issued.
- Deleting a report marks its row **Void**. Its number is never reused.
- Generate needs an internet connection. If the upload fails after the number is issued, the report shows "Not saved to Google Drive yet" with a **Retry** button, and the tool retries by itself when the phone is back online.

## Good to know

- Drafts show `---` as the number until Generate. The number field is read-only once connected.
- Reports generated before you connected are not uploaded and keep their old numbers.
- `report data.json` has the same format as Settings, Download backup. Restore it from Settings to reopen a report on another device.
- Keep the web app URL and the access key private. To change the key, edit `ACCESS_KEY` in the script, then **Deploy, Manage deployments, Edit, New version, Deploy**, and enter the new key in each device's Settings.
- Changing the script later: the same **Manage deployments** steps keep the same URL.
- Open the tool in Chrome, Edge or Safari. Some preview panes block connections to Google.
- Share the Drive folder or the Sheet with colleagues from Drive in the normal way. The script's data stays private to your account until you do.

# AVRIS Site Visit Reports (website)

A staff website for AVRIS surveyors.

- `site/index.html` is the homepage and guide: how it works, visit types, before you start, first-time setup, what Generate does, help.
- `site/app.html` is the report tool. It runs entirely in the browser (Python engine included). There is no server and no build step.
- `admin/` holds the optional Google Drive numbering script and its set-up steps. Netlify does not publish this folder.
- `netlify.toml` tells Netlify to publish the `site` folder.

## Put it on GitHub

1. Sign in to github.com and choose **New repository**. Name it `avris-visit-report`. Choose **Private**. Create it.
2. On the new repository page choose **uploading an existing file**.
3. Unzip this package on your computer. Drag the **contents** (the `site` folder, `admin` folder, `netlify.toml`, `.gitignore`, `README.md`) into the page. Do not drag the zip itself.
4. Choose **Commit changes**. `site/app.html` is about 10 MB, which is within GitHub's 25 MB per file limit for web upload.

## Deploy on Netlify

First time:
1. In Netlify choose **Add new project**, then **Import an existing project**, then **GitHub**, and pick `avris-visit-report`.
2. Leave **Build command** empty. Set **Publish directory** to `site` (it is read from `netlify.toml`). Choose **Deploy**.

If the site `avris-visit-report` already exists from a drag-and-drop deploy, open it, choose **Site configuration**, then **Build and deploy**, then **Link repository**, and pick the repository. Netlify rebuilds on every commit.

After deploy, the homepage opens at the site address and the tool at `/app.html`.

## Important: keep the same address

Reports are stored in each browser, per web address. Keep using the same Netlify address (or one custom domain). A different address starts with no reports. Redeploying the same site keeps everyone's reports.

## Change something later

- Text on the homepage: edit `site/index.html` on GitHub and commit.
- Visit types, steps or report layout: these live in the tool source, not in this package. Ask for a rebuilt `app.html` and replace `site/app.html`.
- Never put the Google access key in this repository.

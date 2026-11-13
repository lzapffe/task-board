# SPARK-tracker

A small web app for following the projects in SPARK, the University of Oslo's programme for social innovation: applicants, projects and their phases, tasks, activities (workshops, mentor meetings, pitch, with agenda variants, files and experiences), contacts, a budget and e-mail templates. It is made for one person (the programme coordinator) and works on a PC and an Android phone.

The app's screens are in Norwegian. This documentation is in English; Norwegian words are only used for names you see in the app (for example **Oppgaver** = tasks, **Arbeidsflyt** = workflow).

## How it is built

| Part | Where it lives | What it does |
|---|---|---|
| **The page** (`index.html`, `app.js`, `styles.css`, `sw.js`, icons) | This repository, published with GitHub Pages | Everything you see and click. Public code, no data. |
| **The back end** (`Kode.gs`) | The Apps Script project attached to the private Google Sheet "SPARK-tracker" | Reads and writes the sheet, makes Docs and backups, runs the daily job. |
| **The data** | The Google Sheet (personal Google Drive) | One tab per kind of data (Prosjekter, Oppgaver, Budsjett ...). Never in this repository. |

The page talks to the back end through the Apps Script **web app** link. Each call carries a secret app key that is saved only in the browser on each device. Without the key the back end answers "Wrong key" and shows no data.

```
Browser (GitHub Pages)  --POST {appKey, fn, args}-->  Apps Script web app (Kode.gs)  <-->  Google Sheet
```

A copy of `Kode.gs` is not kept in this repository by default (it lives in Apps Script). It has no secrets in it, so it can be added here if you want the history in Git too.

## How it runs

- **When you open the page:** it loads all the data once (`api_getData`), draws the page you are on, and sends every change straight to the sheet.
- **Every morning (06–07):** `dailyJob` makes the year's general tasks when a new year starts and opens the new-year review on its date.
- **Every Sunday night (03–04):** `weeklyBackup` copies the sheet and the Docs into a dated folder (the 8 newest are kept).
- **Only when you press a button:** everything else, for example exports, "Last ned alt", phase changes.

See [docs/workflow.md](docs/workflow.md) for the full list, limits and warnings.

## Setting it up from scratch

1. Make a Google Sheet called "SPARK-tracker" in your own Drive. Open **Extensions → Apps Script**, paste `Kode.gs` into `Code.gs` and save.
2. Run `setup()` once (allow the permissions). It makes every tab, the year plan, the event series, the guide Docs, the e-mail templates and the two timed triggers.
3. Run `setupRemote()` once. The log shows the app key. Keep it out of files and chats.
4. **Deploy → New deployment → Web app**, run as *me*, access *anyone*. Copy the link that ends in `/exec`.
5. Put the page files in a GitHub repository with GitHub Pages turned on.
6. Open the page, paste the `/exec` link and the app key. They are saved in that browser only.

## Common changes

| I want to ... | Do this |
|---|---|
| Change the year plan (which tasks come when) | In the app: **Mer → Årsplan** (sheet tab: Progress). No code. |
| Make tasks wait for other tasks | **Mer → Arbeidsflyt**, or "Låses opp av" in a task form. |
| Edit the e-mail templates | **Mer → E-postmaler → Rediger**. |
| Change a rule (days before a deadline a task shows, required workshops ...) | **Mer → Innstillinger**. |
| Change a word or a label on screen | Search for the text in `app.js`, change it, then release (below). |
| Change colours | The tokens at the top of `styles.css` (light first, then dark). See [docs/code/styles.css.md](docs/code/styles.css.md). |
| Add a column to a tab | Add it at the **end** of that tab's list in `SCHEMA` in `Kode.gs`, run `setup()` again. |
| Let the page call a new back-end function | Add it to `REMOTE_FUNCTIONS` in `Kode.gs` and make a new deployment version. |

### Releasing a new version of the page

1. Raise the number in `?v=N` in `index.html` (two places) and in `sw.js` (`CACHE = 'spark-vN'` and the two file names in `FILES`).
2. Add an entry at the top of [CHANGELOG.md](CHANGELOG.md).
3. Upload the changed files, commit and push.
4. If `Kode.gs` changed: paste it in Apps Script, and **Deploy → Manage deployments → edit → New version**. The link stays the same.

## Files

- [index.html](index.html): the page shell and its security rules. Explained in [docs/code/index.html.md](docs/code/index.html.md).
- [app.js](app.js): all the page logic. Explained in [docs/code/app.js.md](docs/code/app.js.md).
- [styles.css](styles.css): the look, light and dark. Explained in [docs/code/styles.css.md](docs/code/styles.css.md).
- [sw.js](sw.js): the service worker (offline copy of the page files). Explained in [docs/code/sw.js.md](docs/code/sw.js.md).
- `Kode.gs` (in Apps Script): the back end. Explained in [docs/code/Kode.gs.md](docs/code/Kode.gs.md).
- [docs/workflow.md](docs/workflow.md): what runs when, limits and warnings.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

---

*The code and the documentation in this repository are mainly created by Claude (Anthropic's AI assistant), based on the owner's requirements, decisions and testing.*

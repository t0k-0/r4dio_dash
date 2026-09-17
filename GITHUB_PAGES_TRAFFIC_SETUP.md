# Activate live traffic on the GitHub Pages site

The GitHub Pages frontend is static. It cannot run `radio-watch-server.js`, and
the ADS-B/OGN services cannot be called reliably by the browser directly. The
included Node relay must therefore run at a separate HTTPS origin. The existing
`render.yaml` deploys that relay, and the existing Pages workflow injects its
origin into the generated website.

## 1. Push the current repository

Commit and push the complete `main` branch to:

`https://github.com/t0k-0/r4dio_dash`

The root of the pushed repository must contain `render.yaml`,
`radio-watch-server.js`, `package.json`, and `.github/workflows/pages.yml`.

## 2. Deploy the relay on Render

1. Sign in to the Render dashboard.
2. Select **New → Blueprint**.
3. Connect the GitHub account that owns the repository, if necessary.
4. Select `t0k-0/r4dio_dash` and the `main` branch.
5. Leave the Blueprint path as `render.yaml`.
6. Review the `r4dio-dash-cz` Node web service and select **Deploy Blueprint**.
7. Wait until the service status is **Live**.
8. Copy its HTTPS origin. It will look similar to:

   `https://r4dio-dash-cz.onrender.com`

Use only the origin—do not append `/api`, `/api/live-traffic`, or a trailing
query string.

## 3. Verify the relay before connecting Pages

Open these addresses in a browser, replacing the example origin if Render gave
the service a different one:

- `https://r4dio-dash-cz.onrender.com/api/health`
- `https://r4dio-dash-cz.onrender.com/api/live-traffic`
- `https://r4dio-dash-cz.onrender.com/api/metars`

`/api/health` must return JSON containing `"ok": true`. The traffic response
must contain `feeds` and `aircraft`; the METAR response must contain `reports`.
A free service can need a short initial warm-up before the first response.

## 4. Test the relay from the published frontend

Before changing the repository setting, open this temporary test URL with the
real Render origin substituted:

`https://t0k-0.github.io/r4dio_dash/?apiBase=https://r4dio-dash-cz.onrender.com`

Enable **LIVE**. The tracker statistics should update without an HTTP 404. This
query parameter is only a test override; the permanent configuration is next.

## 5. Add the GitHub Actions variable

1. Open `https://github.com/t0k-0/r4dio_dash`.
2. Select **Settings**.
3. In the left sidebar, select **Secrets and variables → Actions**.
4. Select the **Variables** tab, not the Secrets tab.
5. Select **New repository variable**.
6. Enter this exact name:

   `R4DIO_DASH_API_BASE`

7. Set its value to the Render HTTPS origin only, for example:

   `https://r4dio-dash-cz.onrender.com`

8. Select **Add variable**.

The relay origin is not a password, so it belongs in an Actions variable rather
than a secret. The Pages workflow already reads it as
`${{ vars.R4DIO_DASH_API_BASE }}`.

## 6. Rebuild and redeploy GitHub Pages

The existing Pages artifact does not change when a variable is added. Rebuild
it explicitly:

1. Open the repository's **Actions** tab.
2. Select **Deploy R4DIO DASH to GitHub Pages**.
3. Select **Run workflow**, choose `main`, and confirm **Run workflow**.
4. Wait for both the build and deploy jobs to complete successfully.
5. In the build log, confirm that `npm run build:pages` prints
   `Live-data relay: https://...` rather than `Live-data relay: not configured`.

If **Run workflow** is not yet available, push a small commit to `main`; pushes
also trigger this workflow.

## 7. Confirm the published page

1. Open `https://t0k-0.github.io/r4dio_dash/` without the `apiBase` query.
2. Hard-refresh the page (`Ctrl+F5`).
3. Enable **LIVE**.
4. Open the tracker statistics. ADS-B, OGN, and LOCAL counts should refresh.
5. In browser developer tools, the traffic request should go to the Render
   origin's `/api/live-traffic`, not to `github.io/.../api/live-traffic`.

## Troubleshooting

- **Live traffic relay is not configured**: the Actions variable is absent, is
  misspelled, or Pages was not rebuilt after it was added.
- **traffic API HTTP 404**: an older Pages artifact is still loaded. Rerun the
  workflow and hard-refresh. Also confirm the variable contains only the relay
  origin.
- **HTTP 502 or partial feed**: the relay is running, but ADS-B or OGN is
  temporarily unavailable. Check the Render logs and retry.
- **Render health URL is 404**: the wrong Render service or URL was copied.
- **Works with `?apiBase=...` but not normally**: the relay is healthy; the
  GitHub Actions variable or Pages rebuild is the remaining problem.
- **Local testing**: run `npm start` and open the exact localhost URL printed by
  the server. A generic static server does not provide the traffic API.

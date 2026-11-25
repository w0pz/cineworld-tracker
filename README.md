# Cineworld Ticket Drops

Tracks every film that goes on sale at Cineworld Ireland (cineworld.ie, Cineworld Dublin)
and logs the moment tickets first become available.

## Run

Double-click `start.bat`, or run `node server.js`, then open http://localhost:4321.
Requires Node 18+ and curl (built into Windows 10/11).

The tracker only records drops while it is running. Leave it running, or add a shortcut to
`start.bat` in your Startup folder (Win+R → `shell:startup`) so it starts at login.

## How it works

- Every 12 hours (and whenever you press **Check now**) the server reads cineworld.ie's own API:
  `scheduledMovies` (every film with bookable showtimes) and `schedule` (each showtime with
  format, occupancy and booking link). Press **Check now** when you know tickets are due to go on sale.
- A film appearing there for the first time is logged as **New** (tickets released). The log
  also records **Dates** (new show days added), **Left** (no more showtimes) and **Back**
  (on sale again).
- The first run records the films already on sale as a baseline ("tracked since").
- History is saved to `data/state.json`. Delete it to start over.
- **Fresh ticket drops** (top of the page) lists new films and new dates. **Likely to sell out** rates films by
  how full their screenings are, how fast they filled between your checks, IMAX/4DX screens, preview
  screenings, Q&A events and how few showings there are.
- **My hours** (default Mon–Fri 08:00–16:30, 30 min travel buffer, +20 min trailers) picks the
  ★ best screening for you: the earliest one outside work that is under 70% full. Saved in your browser.
- The page refreshes every minute. Click **Notify me** to get a desktop notification for each new drop.

Settings (environment variables): `PORT` (default 4321), `POLL_MINUTES` (default 720 = 12 h).

Cloudflare blocks Node's built-in HTTP client on cineworld.ie, so requests go through `curl`.

## GitHub Pages

The page is published at https://w0pz.github.io/cineworld-tracker/.

`.github/workflows/check.yml` runs `node server.js --once --out site` at 07:07 and 19:07 UTC, on every push, and
whenever you press **Run workflow** (the page's **Check now ↗** button opens that screen). It saves the
history back to `data/state.json` and deploys the page with a static `state.json`. A run takes about 2 minutes.

If a run turns red with "HTTP 403", Cloudflare is blocking GitHub's servers. In that case run the tracker
locally and push `data/state.json` from your PC instead.

To test the static page locally, add `?static` to the URL.

# Old Time Radio (lite)

One screen, one grid. Static files, no build step, no server code.

- **Stations** – tap one, get a random episode from the start. When it ends, the next one starts.
- **Live** – flip the switch at the top and stations become broadcast channels: every genre (and *All shows*) follows a
  schedule, so tuning in joins the programme already on air, mid-episode, and the next one follows on its own.
  Pausing is muting – pressing play rejoins the broadcast. There is no server: each day's schedule is generated in the
  browser from a seed (station + UTC date), so every device on the same station hears the same programme at the same moment.
  Scrubbing and Next are off in Live mode, like real radio; Download leaves Live (it restarts the episode from 0:00).
- **Shows** – pick any number of shows and shuffle them.
- **Sleep** – 15 min … 2 hours, or end of episode. Survives a reload; checked on every audio tick so it still fires with the screen locked.
- **Download** – fetches the whole episode, restarts it from 0:00 from the local copy, then the button becomes *Save file* (iOS share sheet → Save to Files).
- Lock-screen controls: play/pause, ±seek, next, and *previous = restart episode*.

## Put it on your iPhone

Host the folder on any static host with HTTPS (GitHub Pages, Netlify, Cloudflare Pages), open it in Safari,
then Share → **Add to Home Screen**. It then launches full-screen like an app.

## Refresh the catalog

`catalog/` is a snapshot of archive.org (163 shows, ~23.6k episodes). To rebuild it:

    python3 tools/build_catalog.py

`tools/sources.json` maps each show to its archive.org item(s); delete it to re-discover from oldtime.radio's API.

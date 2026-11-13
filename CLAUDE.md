# The Nashville Life

AI-assisted community Facebook Page for Nashville and the surrounding counties, plus home-for-sale video Reels. A separate copy of The Gilbert Life (repo lennevin/Elite-Agent-Systems), with its own repo, Railway project and Postgres. Single-file `server.js` (Node, Express, Postgres, node-cron, Anthropic SDK), the same `var` / plain-function style.

## News: ingest → score → draft → approve → publish
1. **Ingest:** runs 3 times a day at 6am, noon and 6pm Central (node-cron with `timezone: America/Chicago`), plus once 15 s after each deploy. It reads the RSS feeds in `SOURCES`.
   - **Metro-wide (`nashville` scope):** WSMV, WKRN, NewsChannel 5, FOX 17, Nashville Banner, Nashville Guru.
   - **Cities and counties (`metro` scope):** Williamson, Rutherford, Wilson and Maury County Source sites (they share many stories under different URLs; the title dedupe catches those), plus the Franklin, Murfreesboro, Spring Hill, Columbia, Hendersonville and Lebanon city sites.
   - Tested and not usable (2026-11-13) are listed in the comment under `SOURCES`.
2. **Score:** Claude screens 25 items per call, up to 200 per run. It returns an area from `AREAS`.
   - **Core areas** (`CORE_AREAS`: Nashville/Davidson, Williamson, Rutherford, Sumner, Wilson, Maury) are kept at relevance ≥ `core_min_relevance` (default 6).
   - **Middle Tennessee, statewide and other** stories need importance ≥ `wider_min_importance` (default 8) and relevance ≥ 5.
   - The prompt makes Nashville itself the focus.
3. **Draft:** up to 10 kept items per run, highest importance first. Kept items not drafted within 2 days become `stale`. Fair Housing, crime and politics rules apply, and `checkWarnings()` flags problems for review but never blocks.
4. **Slow-day posts** (`draftFiller`): from 2pm, Claude drafts up to `filler_per_day` (default 2) community posts for tomorrow when there are open slots: Nashville facts, questions and tips. Photo posts only once `assets/photos` has photos; the library is empty for now.
5. **Approve** at `/admin` (basic auth, any username + `ADMIN_PASSWORD`) or from the approval email (Resend, signed links, GET shows a confirmation page and POST does the action).
6. **Publish** every 5 min into `posts_per_day` slots (default 8, 07:00–21:00 Central, so 7, 9, 11am, 1, 3, 5, 7 and 9pm). Posts are never within 45 min of each other.
   - **Link post:** when the article has an og:image.
   - **Photo post:** otherwise, using a 1200×630 card (navy with the skyline and a "Brought to you by" badge).
   - Nothing posts unless `PUBLISH_ENABLED=true`.

Time: all wall-clock math goes through `localParts` / `localSlotToDate` (America/Chicago, with daylight saving; the selfcheck covers the DST days). Do not reintroduce fixed UTC offsets.

## Home videos (Reels)
- **Upload:** the `/admin` "Add a home video" form takes the address, city, price, beds/baths/sq ft, features, whose listing it is, an optional caption, and the video. The browser reads the length and size first and warns if it isn't a 3–90 s vertical video. Upload is XHR with a progress bar. CSRF goes in the `X-CSRF` header because multipart has no parsed body. `busboy` streams the file into `VIDEO_DIR` (1 GB limit).
- **Storage:** `VIDEO_DIR` is `$RAILWAY_VOLUME_MOUNT_PATH/videos`, so the Railway service needs a volume (mount `/data`). Without one, uploads vanish on each deploy. `/health` shows `video_on_volume`.
- **Caption** (`draftVideo`): Claude writes it from the details unless Len typed one. Fair Housing rules apply: describe the home, not who should live there; no school or neighborhood claims. `brokerageLines()` then appends "Listing courtesy of …" for other brokers' listings, plus the `firm_line` setting.
- **Warnings** (`videoWarnings`): length or shape problems, no phone number in `firm_line` (Tennessee advertising rule: firm name and phone), and a reminder that another broker's listing needs that broker's written OK.
- **Queue:** videos sit in the same queue and share the 8 slots. They never expire, and they don't trigger an approval email on their own.
- **Publishing** (`postReel`): `POST /{page}/video_reels` with `upload_phase=start` → upload the bytes to the returned `upload_url` (rupload, `Authorization: OAuth <token>`, `offset`, `file_size`) → `upload_phase=finish`, `video_state=PUBLISHED`, `description`. The post id is stored as `reel:<video_id>` and links to facebook.com/reel/<id>. The file is deleted once posted or rejected.

## Railway variables
- **Required:**
  - `DATABASE_URL`: from the Postgres plugin.
  - `ANTHROPIC_API_KEY`: the separate "Nashville Life" key.
  - `FB_PAGE_ID`
  - `FB_PAGE_TOKEN`: the Page token derived from the "Nashville Publisher" system user. It's an Employee role, because the business allows only one Admin system user. App: "The Gilbert Life Publisher".
  - `ADMIN_PASSWORD`
  - `RESEND_API_KEY`
  - `PUBLISH_ENABLED`
- **Optional:** `DIGEST_EMAIL`, `EMAIL_FROM`, `LINK_SECRET`, `PUBLIC_URL`, `CLAUDE_MODEL` (default `claude-opus-5-5`), `FB_GRAPH_VERSION` (default `v26.0`), `VIDEO_DIR`, `DATABASE_SSL=false`.

## Checks
`node selfcheck.js` runs offline checks on the helpers: warnings, dedupe, Central-time and DST slot math, cards, email links and video warnings. `node selfcheck.js --feeds` also fetches every feed once.

## Not yet verified
- The first real Reel post. Check that the finish step returns success and the Reel shows publicly.
- Whether Railway's proxy accepts uploads of several hundred MB. If big uploads fail, export the video at 1080×1920 and a lower bitrate.

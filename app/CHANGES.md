# Mame Inventory — fix report

## Round 10 — macOS: the database died when the window was closed

The first Mac install failed, and the log showed the cause without a single
ERROR line in it: five `[Backup] shutdown` entries between 18:13 and 18:24
with **no `launch` line between them**. The app had never quit and never
restarted — so those five "shutdowns" were the user closing the window five
times while the app stayed in the Dock.

`window-all-closed` closed the backend and then deliberately did not quit on
macOS (the standard Electron pattern). On Windows that is harmless, because
closing the window quits the app. On macOS the app stays in the Dock, so the
first window close killed the database and left the app running without one.
Clicking the Dock icon reopened a window that could never reach its backend:
it hung on "Opening your shop data…" and then reported that it could not open
the shop database.

Fixed:
- the backend now outlives the window and is stopped only by a real quit
- `before-quit` holds the quit open until the final backup is on disk
  (Electron does not wait for async listeners, so this needed an explicit
  `preventDefault` and a re-quit)
- reopening from the Dock restarts the backend if anything stopped it
- closing the window is no longer recorded as a "shutdown"

Also fixed while in there: only 30 backups are kept, and every window close
was writing one. Five in eleven minutes, as the Mac log shows, would push a
month of history out in an afternoon. Window-close backups are now rate
limited to one per five minutes — but a **real** shutdown backup is never
skipped, since that is the one holding the most recent data.

### Verified

The macOS lifecycle can be forced on Linux (`MAME_FORCE_MAC_LIFECYCLE=1`), so
this was tested rather than reasoned about:

| | old code | fixed |
|---|---|---|
| backend up before closing window | up | up |
| backend up after window closed | **DEAD** | up |
| window reopens from Dock | yes | yes |
| backend up after reopen | **DEAD** | up |
| what the reopened window shows | "Opening your shop data…" (hangs) | the dashboard |

The old-code column is the exact failure from the customer's machine,
reproduced here. Normal Windows/Linux quit was re-checked too: the app still
exits cleanly and still writes its shutdown backup.

## Round 9 — rebrand to Mame, orange theme

### Renamed

Every occurrence of Avanza became Mame: the app name, window title,
installer, sidebar brand, database file, backup file names, log file,
PDF headers and export file names, the internal app id, and the stored
settings keys.

Because the app id, product name and user-data folder all changed, **Mame
is fully independent of Avanza** — both can sit on the same computer
without touching each other's data. Verified on a packaged build: the
data now lives in `mame-inventory/mame_shop.db`, backups are written as
`mame-backup-*.db`, and the log is `mame.log`.

Importing a backup exported by the older Avanza build still works, in
case a shop ever needs moving across.

### Previous customer's details removed

Settings displayed a hardcoded **Address: Merkato Sinimaras**, and the
default branch was **"Merkato sinimaras (sosa building)"** — the previous
customer's real details, presented to the next customer as their own.
Address is now an editable field stored per shop, and the default branch
is a neutral "Main Branch".

### Orange theme

Primary `#c2410c`, accents `#ea580c`, tints `#ffedd5` / `#fff7ed`.

The primary was chosen by measurement, not by eye: white text on it is
5.18:1, against 5.17:1 for the blue it replaced, so nothing became harder
to read in the recolour. 81 colour tokens were swapped across the
stylesheets.

Two places needed more than a swap. The "purchase spend" metric icon and
one report marker would have become a second orange sitting beside the
existing one, so they are teal — clearly a deliberate choice rather than
leftover branding. The pie palette was re-spaced by hue
(orange/teal/violet/pink/green) because leading with the brand orange had
put it next to an amber.

### Contrast bugs found while checking the recolour

Earlier rounds only ever audited **dark** mode. Auditing light mode too
turned up problems that pre-date the rebrand:

- **42 elements at 2.56:1.** The muted grey `#94a3b8` on white — used for
  every table header, caption and breadcrumb, at 9-11px, read on cheap
  shop screens in daylight. Now `#64748b` (4.76:1). The sidebar keeps the
  lighter grey, where it sits on navy at 6.96:1 already.
- **The "Detail" button was invisible in dark mode.** It hardcodes a white
  background, and the dark theme's blanket `button { color: #fff }` then
  painted white text on it — contrast 1.0.
- **The expense subtotal rows were invisible in dark mode**, the same way.
  These only render once a shop has expenses, which is why passes over an
  empty shop never surfaced them.
- **Chart legend labels at 2.15:1**, coloured by series. The swatch now
  carries the colour and the label reads as body text. The legend had also
  drifted out of sync with the line colour.
- Series colours are now `#ea580c` and `#0d9488`, which clear 3:1 on both
  the white card and the dark card, so one pair serves both themes.
- Settings labels were breaking mid-word ("Addre/ss", "Branc/h"): a round-8
  rule used `overflow-wrap: anywhere`, which also shrinks an element's
  minimum width. Fixed labels now use `break-word`; user-entered text keeps
  `anywhere`, which is what it was added for.

Both themes now pass with zero text below 3:1 across all nine pages.

### Verified after the change

- Light and dark contrast: clean, all pages, with data
- Layout: 2 languages x 7 display sizes x 9 pages with hostile data — no
  overflow
- Empty shop: still no invented figures anywhere
- Sale recorded, stock decremented, receipt numbered SO-0001, sale linked
  by product id; product renamed then sale deleted — stock correctly restored
- PDF export: new file names, rebranded header, still injection-safe, a
  product named `1/2" <pipe> & Sons` renders literally
- Backup export/reset/import round trip across every collection
- Packaged app: backend starts, database created, backup written, zoom
  works, PDF engine works
- Windows installer rebuilt and its payload integrity-checked (109 files)

## Round 8 — the "install it and leave it" tests

Simulated the things that only show up after months in a shop.

### Power cuts — passed

The backend was killed with SIGKILL (no chance to clean up) 25 times, at
random moments during database writes. After every cut:
`PRAGMA integrity_check` = ok, foreign keys ok, and **zero confirmed writes
lost**. SQLite's write-ahead log does its job.

### Two years of data — passed, after two fixes

Generated 6,265 sales, 180 products, 220 customers, 219 purchases and 223
expenses across 24 months. Cold start 0.5s, every page under 0.35s,
recording a sale 0.9s.

**Fixed: the all-time PDF export never completed.** The report HTML was
passed to the PDF renderer as a `data:` URL; at 1.85 MB it exceeded
Chromium's limit and the export silently hung forever. It now goes through a
temp file. A shop would have hit this after about a year.

**Fixed: the all-time report was 238 pages and took 14 seconds.** Detail
tables now show the 300 most recent rows with a plain notice —
"Showing the 300 most recent of 6,266 transactions. The totals above cover
the full period." Totals are still calculated over everything, so no figure
is ever understated. 238 pages/13.7s became 18 pages/0.7s.

### Unattended running — passed, after one fix

- 400 days of daily backups: 30 files kept, 90 MB, bounded.
- 12 consecutive launches of the packaged app: backend and backup fine every
  time, database integrity ok.
- 300 page switches then 20 sales in one session: heap flat at 10 MB, no
  uncaught errors.

**Fixed: the log could grow without limit.** Rotation only happened at
launch, so an app left open for months with something failing repeatedly
would write an unbounded file. Rotation now happens as it writes: 200,000
error lines produce 204 KB total. (The first attempt at this crashed under
load — a stream can be written to after `end()` — so logging is now
synchronous, which removes that class of bug entirely.)

### Ethiopian calendar — two real bugs found and fixed

The new year shifts to 12 September when the **following** Gregorian year is
a leap year; the code tested the current one. Worse, the forward and backward
conversions used different rules, so they disagreed with each other on **508
days out of every six years** — a date entered in the picker could come back
as a different date.

Rewritten so both directions share one definition. Now verified: round-trip
exact for every day over 20 years, no impossible dates produced, and the
known anchors all correct — Meskerem 1 in 2023/2024/2026/2027, Pagume 6 in
leap years, Genna (7 Jan) = Tahsas 29, Meskel (27 Sep) = Meskerem 17.

### Also fixed

- `/api/health` had been deleted when the auth routes were removed in round 6.
- Billion-scale totals overflowed the metric cards on some widths.

Final regression: 2 languages x 7 display sizes x 9 pages with two years of
data — zero overflow, no uncaught errors.

## Round 7 — systematic bug hunt

Rather than reading code, the app was driven through a browser against the
real backend and business invariants were asserted against what actually
landed in SQLite. Four real bugs found and fixed.

### 1. Stock silently lost when a renamed product's sale was deleted

Sales recorded only the product NAME, never its id. If a shop renamed a
product and later deleted or edited one of its sales, the app could not
find the product, so the stock was never given back. The shop quietly lost
inventory with no error.

Sales now carry `productId`. Existing sales are linked to their product
automatically on first launch (matched by name, which still works at that
moment), so shops already running are repaired on upgrade. The name lookup
remains as a fallback.

### 2. Purchase numbers started at PO-1050

Same class of problem as the SO-2085 receipt numbers: a new shop's first
purchase printed as PO-1050, and numbers were reused after a deletion. Both
now continue from the highest number actually issued: SO-0001, PO-0001.

### 3. A product name containing `<`, `>`, `&` or a quote corrupted the PDF

The PDF templates interpolated product, customer and supplier names into
HTML without escaping. A perfectly ordinary shop name — `1/2" <pipe> & Sons`
— broke the report layout, and arbitrary markup could reach the document.
All 26 user-entered interpolations are now escaped. Verified by rendering
the generated HTML and asserting no injected elements exist.

### 4. Long unbroken names overflowed the activity rows

A customer name with no spaces pushed past the Overview activity list and
the receipt summary lines at 1024–1093px.

### Confirmed working (no bug found)

Stock arithmetic on sale, sale edit and purchase delete; credit balances
(computed from sales, not stored, so they cannot drift); report period
filters (day/week/month/year/all); backup export→reset→import round trip
across all six collections; five rapid sales queued in order with unique
ids; decimal rounding; backend killed mid-session — the badge warns the
user and the queued sale is written when it returns.

Final regression: 108 page-views (2 languages x 6 display sizes x 9 pages)
with hostile data — 70-character unbroken names, 8-figure values, markup in
names — zero overflow. Empty shop: no non-zero figure anywhere on screen or
in an exported PDF.

## Round 6 — invented numbers audit, and sign-in removed

### No fabricated figures anywhere (audited, not assumed)

The Reports page had a second, dead copy of the chart code still holding
the demo arrays; it is deleted. A full sweep of the source found no other
invented values.

Receipt numbers were `SO-${2085 + sales.length}`, so a brand new shop's
first sale printed as **SO-2085** — implying 2,084 sales that never
happened — and numbers were reused after a deletion. Now they continue
from the highest number actually issued, starting at SO-0001.

Verified empirically on a completely empty shop:
- every page scanned, text node by text node: the only non-zero numbers
  on screen are dates and clock times
- exported PDF scanned: every money figure is `ETB 0.00`

### Sign-in removed

The app opens straight to the dashboard. The Account panel in Settings is
now just the owner's display name, stored as a setting and used in the
top bar and on printed reports.

The backend no longer requires a session. This is defensible here: it
listens on 127.0.0.1 only and serves the single app on that machine, and
anyone who can open the app can already open the database file — so the
login added friction for shop staff without adding real protection. A
shop that needs to keep staff out should use Windows user accounts.

`scripts/server/auth.ts` is kept but unwired, so multi-user support can
be switched back on later without rewriting it.

## Round 5 — PDF export on customer machines

"Export PDF" opened a window and called `window.print()`, relying on the
customer's Windows having a "Microsoft Print to PDF" printer. On machines
with no printer it silently did nothing.

Now the desktop shell renders the report with Chromium's own PDF engine
(`printToPDF`), shows a Save dialog defaulting to the Documents folder,
writes the file and opens it. No printer involved. Applies to all three
exports: reports, customer statements, expenses. Verified in a packaged
build on a machine with no printer; Amharic text renders in the PDF.

Also removed: the Reports page showed **fabricated demo figures**
("Meskerem 1: 4,500", a "Pipes 45,000" pie) whenever a shop had no sales
yet. A customer would have seen sales they never made. Charts are now
simply empty until there is data.

## Round 4 — second Windows test result

The log from the first successful install showed the backend dying on
startup with `no such column: expires_at`. The laptop still had the
database from the **original** app version, which had created a
`sessions` table with different columns. `CREATE TABLE IF NOT EXISTS`
kept the old table, and the first query against it failed.

Fixed with a schema guard (`scripts/server/schema.ts`): every table the
code depends on is checked column-by-column at startup. A table with the
right name but the wrong shape is renamed to `<name>_legacy_<timestamp>`
- never dropped - and a fresh one is created. Tested against a database
with the old layout: starts cleanly, old tables preserved, second start
silent.

Also confirmed from that log: the in-process backend, the log file and
the diagnostic screen all behaved exactly as intended on real Windows.

## Round 3 — first Windows test result

The first Windows install showed a **Sign in** form with "Could not reach
the local database service" under it. There were never any credentials:
the backend had not started, so the app could not ask whether an account
existed and fell back to the sign-in form. Three changes:

1. **The backend now runs inside the app's own process.** Earlier versions
   spawned a separate, unsigned `node.exe` from AppData - exactly what
   Windows Defender and SmartScreen like to block silently. There is no
   longer a second executable to block. `better-sqlite3` ships N-API
   prebuilds, so the same binary loads in Electron. The installer shrank
   by 22 MB. Verified in a packaged build.
2. **A log file.** Everything the shell and backend print goes to
   `%APPDATA%\ledgerly-inventory\logs\avanza.log`. A problem on any
   customer's machine can be diagnosed from that file alone.
3. **The startup screen shows the real error**, plus the log path and an
   "Open log file" button, and it does so immediately rather than after
   30 seconds of retries. It never falls back to a sign-in form when the
   backend is down. Verified by deliberately breaking the backend bundle.

If it still fails, the screen and the log say exactly why.


Everything below is applied to the source in this archive, built, and
verified by driving the real app. Round-1 fixes (fonts, layout, window
sizing, zoom, packaging, dark mode) are still in; they are summarised at
the end so this file is the single reference.

---

## The one decision that mattered: SQLite is now the only database

### What was actually happening

`src/pages/*`, `src/api/*` and most of `src/components/*` were **dead code** —
an abandoned earlier attempt. The live app lived entirely inside `main.tsx`
and never called the API. Every product, sale, purchase, customer, supplier
and expense was in `localStorage`: Chromium's browser cache, capped at a few
MB, wiped by cleanup tools, and not a file anyone can copy to a USB stick.
The SQLite server was running and seeding tables the UI never read.

The "Export database" button read from `localStorage` and **left expenses
out**, so the backup it produced was incomplete.

### What changed

- `scripts/server/store.ts` — a document store in SQLite: one row per record,
  keyed by (collection, id), body as JSON. Batched upserts/deletes in one
  transaction. Whole-snapshot replace for import/reset, atomic so a failed
  restore can never leave half of one backup and half of another.
- `src/store.ts` — a hook that gives the UI the same `setProducts`,
  `setSales`, … setters it already used, diffs each array by id after every
  change, and writes only what changed. **None of the business logic in
  `main.tsx` was touched.** Writes go through a serial queue with retry and
  backoff so they reach the database in order.
- A "Saved / Saving… / Not saved / Offline" badge in the top bar, a startup
  screen that explains itself if antivirus blocks the backend, and a warning
  if the window is closed while a write is still in flight.
- **Upgrade path.** On first launch after updating, if SQLite is empty and
  `localStorage` has data, it is migrated across and `localStorage` is
  cleared. If SQLite already has data, any stale `localStorage` copy is
  discarded — it can never become a second source of truth again.
- The dead code was removed: `src/pages`, `src/api`, seven unused
  components, the Postgres module, `db/schema.sql`, and the seed data.

### Verified

Real backend + real build, driven through a browser, then the SQLite file
read directly:

- Add / edit / delete a product → in SQLite; `localStorage` stays empty
- Full sale and credit sale → stock decrements, customer auto-created, due
  date stored
- Expenses, suppliers, customers → all persist
- Reload → data returns from SQLite, not memory
- Export → Reset → Import → all six collections restored
- Legacy `localStorage` data → migrated on first launch; stale copy ignored

---

## Login screen and real authentication

First run asks the owner to create an account. After that: email + password.
Sessions are stored on that machine only and sent with every data request.

- Passwords: scrypt with a per-user random salt, constant-time comparison.
  A wrong password and a non-existent email take the same time to answer.
- `/api/store`, `/api/settings`, `/api/backup` and `/api/checkpoint` now
  return **401** without a session — nothing else on the computer can read
  the database over the local API.
- After the first account exists, creating another user requires being
  signed in (`403` otherwise).
- "Log out" in Settings → Account.

Verified: first-run setup, 8-character minimum, sign in, sign out, wrong
password rejected, session survives reload, unauthenticated API blocked.

---

## Automatic backups (a selling point for an offline app)

The Electron shell copies the whole SQLite file to
`%APPDATA%\ledgerly-inventory\Backups\avanza-backup-<date>.db`:

- one minute after launch, every 24 hours while open, and on shutdown
- keeps the newest 30
- asks the backend to checkpoint its write-ahead log first, so every copy
  is a complete single file
- Settings → "Back up now" and "Open backup folder"

To restore: sign out, close the app, copy a backup over `avanza_shop.db`
in that folder, reopen.

---

## Electron shell — tested for real

The packaged app was built and launched under a virtual display, with an
env-guarded self-test hook (`AVANZA_SELFTEST`, never set in normal use)
that reports what the shell actually did.

| Check | Result |
|---|---|
| `app.isPackaged` and asar-aware paths | resolved to `app.asar.unpacked/build` ✔ |
| Backend spawned from bundled runtime | alive, DB created in user-data ✔ |
| Renderer loaded from inside the asar, talked to the API | first-run screen rendered ✔ |
| Window on 1366×768 | 1326×728 (was 1536×864 hanging off screen) ✔ |
| Window on 1920×1080 | 1536×864 ✔ |
| Zoom IPC | 1.0 → 1.3 ✔ |
| Backup on demand | written ✔ |

Two robustness bugs surfaced during this and are fixed:

- **Port 3001 in use** (another app, or a backend left behind by a crash):
  the old code's backend died silently and the app talked to whatever was
  listening. Now the shell finds a free port at launch and tells the
  renderer through the preload script. Tested with 3001 deliberately
  occupied — backend moved to a random port, app worked.
- **Two copies of the app** would have run two backends against one
  database. `requestSingleInstanceLock` now focuses the existing window.

Also: `node_modules` is no longer packed into the asar (the server is one
bundled file). The archive went from 43 MB to 1.2 MB.

---

## Amharic

160 visible strings were hardcoded English. They are now wrapped as
`tx('English text')` and translated in `src/i18n/phrases.ts`, keyed by the
English text so nothing can ever render blank. `<html lang>` is set so the
Ethiopic type scale applies.

**A native speaker should read `phrases.ts` before the first customer sees
it.** The translations were written to be natural for a Merkato hardware
shop, but edit the right-hand side freely. Some strings remain English:
the breadcrumb, eyebrow labels ("WORKSPACE OVERVIEW"), a few count strings
like "4 active products", and the branch name (which is the shop's own data).

The currency formatter put a non-breaking space between "ETB" and the
digits, which stopped very large values from ever wrapping. Fixed, and the
four metric cards now go 2×2 below 1400px so a 13-digit stock value fits.

---

## Final layout audit

2 languages × 6 display configurations × 9 pages, with 70-character product
names and 8-figure currency values: **zero overflowing elements, zero
horizontal scroll** in every combination.

| Display | Effective viewport |
|---|---|
| 1920×1080 @100% | 1920×1040 |
| 1920×1080 @125% | 1536×832 |
| 1920×1080 @150% | 1280×693 |
| 1366×768 @100% | 1366×728 |
| 1366×768 @125% | 1093×614 |
| minimum supported | 1024×640 |

`tsc -b`, `vite build`, `build:server` and `electron-builder` all pass.

---

## What still needs a Windows machine

One thing, and it is small: run `npm run dist:win`, install the result, and
confirm it opens. Everything the packaged shell does — asar paths, backend
spawn, window sizing, backups, zoom — has been exercised in a real packaged
build here, but on Linux. The remaining Windows-only surface is the NSIS
installer itself and `node.exe` being found by `copy-runtime.cjs`.

## Also worth knowing

- The user-data folder is named `ledgerly-inventory` because that is the
  `name` in `package.json`. Existing installs already use it, so it was
  left alone. Renaming it would orphan every existing shop's database.
- Under a bare virtual display without a window manager, `maximize()` is a
  no-op, so the "maximise when the screen is small" path was not observable
  here. On Windows it works.
- `/api/backup` (JSON export) requires a session now; the Settings export
  button sends one.

---

## Round 1 (still applied)

- Fonts bundled: Inter, DM Mono, Noto Sans Ethiopic — no network at runtime.
  Amharic had no glyphs in Inter at all.
- `typography.css` blanket overrides replaced with one variable-based scale.
- `layout-fixes.css`: `height` → `min-height` on controls, tables scroll
  instead of clipping, breakpoint at 1250px, modal grids collapse.
- Window clamped to the display work area, `useContentSize`, `minWidth` 1024.
- Zoom uses Chromium's zoom factor (CSS `zoom` broke fixed-position modals),
  50–200%, persisted.
- Server binds to `127.0.0.1` (was `0.0.0.0`), CORS locked down.
- `asar: true`; dependencies pinned to what the lockfile had resolved;
  `pg` removed; duplicate build config in `dist-win.cjs` removed.
- Dark mode: five invisible elements (contrast 1.0) fixed.

## Round 11 — cartons, supplier credit (Avanza 0.2.0)
- Items list shows pack units properly: "10 cartons (1,000 pcs)", "9 cartons + 50 pcs". Stock is still stored in pieces, so values and profit are unchanged. Cost column says "/ pc" (or "/ m", "/ kg").
- Sales can be made by the whole carton or by the single piece.
- Purchases can be recorded "On credit" with an amount paid now and an optional due date. Suppliers page shows what is owed, due/overdue dates and a "Pay supplier" button (oldest purchases paid first). Old purchases count as fully paid.
- Fixed: purchase form pre-filled an invented unit cost of 8.50 instead of the item's cost; supplier "Last delivered" never updated (now taken from purchases); editing a sale that used the last stock failed; dark-mode sale/purchase windows had invisible buttons and product names; Items/Suppliers/Purchases buttons cut off on narrower windows; low-contrast hint text.
- scripts/make-brand.cjs produces the Avanza build from this source, keeping Avanza's data locations (ledgerly-inventory folder, avanza_shop.db, avanza2- settings) and blue theme.

## Round 12 — supplier PDFs (Avanza 0.2.1)
- Suppliers page: every supplier has a "PDF" button that saves a statement: all purchases from them, paid, still owed, overdue, due dates, totals.
- Reports PDF: new "Owed to Suppliers" figure and table (balances as of today, overdue flagged); purchase table now shows Paid and Owed per purchase.
- Fixed: customer PDF total row was shifted one column (the sales total sat under "Paid", paid under "Balance").

## Round 13 — sorting and dates (0.2.2)
- Purchases and Sales lists now show the newest first by default, with a sort menu: Newest first / Oldest first / Highest amount / Lowest amount. Before, lists came out in the order records were saved (oldest first) and the "Filters" button did nothing.
- Sales "Month" and "Year" now follow the Ethiopian calendar, matching their labels (they used the Gregorian month/year while showing an Ethiopian month name).
- Times were saved in UTC (3 hours behind Ethiopia): a 9:30 purchase showed 06:30. New records save local time; older records are converted when shown. Stored data is not rewritten.
- "Today", "this week" and "this month" now use the local date everywhere (they used UTC, so between midnight and 3am "today" was still yesterday).
- Overview: recent activity ordered by date and time; removed a dead "This week" button.

## Round 14 — iCloud backup and restore (Mac, 0.3.0)
- Every backup is also copied to iCloud Drive → "Mame Backups" when iCloud Drive is on. No login or setup in the app; macOS uploads the folder by itself. The live database never goes into iCloud: finished copies are staged privately and moved in with one atomic rename.
- Backups: a minute after opening, every hour while open (only if something changed), on window close/quit, "Back up now", and just before a restore.
- Kept (on the Mac and in iCloud): newest 48, plus the newest of each day for 60 days.
- Settings → iCloud backup card: last copy time and number of copies, or a plain-language warning (iCloud Drive off, macOS permission, no space, copy failed) with how to fix it. Hidden on Windows.
- Settings → Restore from backup: lists backups from this computer and iCloud (downloads iCloud-only ones when chosen), shows what the backup contains before changing anything, saves the current data as a "Before restore" backup first (undo), then replaces the data. Damaged or wrong files are refused.
- Fixed: Settings labels broke mid-word ("Addres/s", "Branc/h").
- Test hooks (never set in normal use): MAME_ICLOUD_DIR, MAME_BACKUP_INTERVAL_MS, MAME_BACKUP_STARTUP_DELAY_MS.

## Round 15 — customer menu (0.3.1)
- Customers: the "•••" button did nothing. It now opens Edit / Delete, like Purchases. It is also shown for customers who owe money (it used to be replaced by "Pay Credit", so they could not be edited at all).
- Renaming a customer moves their past sales and credit to the new name. Duplicate names are refused.
- Deleting is refused while the customer still owes money; their past sales always stay in Sales and reports.
- Overview/Purchases: the branch name looked like a dropdown (▾) but did nothing; it is now a plain label (change it in Settings).
- Windows build (Avanza) also gets, from rounds 14: "Restore from backup" in Settings, hourly backups when something changed, and the keep-48-plus-daily rule. The iCloud card is Mac-only and hidden on Windows.

## Round 16 — supplier menu (0.3.2)
- Suppliers had no way to be edited or deleted. Each row now has a "•••" menu with Edit / Delete, like Customers and Purchases.
- Renaming a supplier updates all purchases from them (including older ones linked only by name) and links them by id, so the amount owed, due dates and PDF follow the new name. Duplicate names are refused.
- Deleting is refused while the shop still owes that supplier; purchases from them always stay in Purchases and reports.
- A supplier that was only typed on a purchase (no supplier record) can be saved with contact details from the same menu.

## Round 17 — full sweep for surprises (0.4.0)
Found by a four-way code review, each reproduced in the real app before fixing.
Data safety
- Saving never gives up: a change that could not be written was dropped after ~1.5 minutes of failures (the screen kept showing it; it was gone after a restart). It now retries until it works; the badge says "Not saved" meanwhile and "Saved" again after.
- Reset All Data and Import database now make a "Before restore" backup first (undo), like Restore does. Those undo backups are kept 30 days.
- A restore/import/reset waits for pending saves, so an old save cannot land on top of it.
- Editing an item's pack size no longer changes its stock (100 pcs in boxes of 10 became 50 pcs when the box size was corrected to 5).
- Editing or deleting a purchase whose stock was already sold is refused instead of making stock negative.
- Delete now asks first for sales, purchases, expenses and items (it deleted on one click).
Numbers
- Selling price: there was no field for it; the app invented cost + 35%, pre-filled it in every sale and reset it on every edit. Items now have a real "Selling price" field; old invented prices are not shown or used. A sale asks for the price when none is set.
- Purchases "Purchase spend" said "This month" but showed all time; it now follows the period selector. "Items received" added cartons, rolls and pieces into one number; replaced by "Owed to suppliers".
- Reports gross profit and Graph categories lost the cost/category of items that were renamed.
- One meaning of week/month/year everywhere (Monday weeks, Ethiopian month and year): Expenses, Reports, Graph, Purchases and the expenses PDF used European months while Sales used Ethiopian.
- A sale typed as "abebe" is saved under the existing customer "Abebe" (it used to fall out of Abebe's credit).
Dead ends
- Notifications: rows open the right page; supplier payments due are included.
- Narrow window / 200% zoom: the menu button now opens the menu (it did nothing, leaving no way to change page).
- Record sale explains why it can't save (not enough stock, no price...) instead of doing nothing.
- Escape closes windows; clicking outside closes notifications; search on Sales.
- Removed a fake workspace dropdown arrow; Settings/Reports texts no longer promise "team access, billing" or "interactive visuals"; page descriptions filled in; Overview explains an empty activity list.

## Round 18 — sort menus everywhere (0.4.1)
- Customers: sort by Name A–Z (default), Owes the most, Spent the most, Newest customer.
- Suppliers: sort by Name A–Z (default), Owed the most, Last delivered; and a search box (name, contact, phone).
- Items: sort by Name A–Z (default), Low stock first, Highest stock value, Category.
- Expenses: Newest first (default), Oldest first, Highest amount, Lowest amount (within each category; categories follow the chosen order).

## Round 19 — Overview, dates, buying by the piece (0.4.2)
- Overview: removed the "Stock value" card. Figures are hidden until "Show figures" is clicked (every time). The app now opens on Items.
- Ethiopian dates one day off on computers whose time zone is behind UTC (e.g. a Windows PC left on an American time zone): stored dates were read as midnight UTC. Fixed for any time zone. The date picker also had its own leap-year rule that put 2016 and 2017 E.C. one day off; it now uses the checked conversion (and Pagume has 6 days in leap years).
- Avanza only: purchases can be recorded by the whole carton or by the single piece (src/features.ts, switched on by make-brand). Stock, totals, edit, delete, lists and PDFs count loose purchases correctly; older purchases are unchanged.

## Round 20 — stock list PDF, Mac build from Windows (Mame 0.4.3)
- Mame only: "Stock list PDF" button on Items: every item with its quantity (in its own units), cost price and stock value, plus the total stock value. Items with stock but no cost price are flagged instead of silently counting as zero. (src/features.ts ITEMS_STOCK_PDF; make-brand switches it off for Avanza.)
- scripts/build-mac-on-linux.sh: builds and signs the Mac app from Windows (WSL/Ubuntu) or Linux - the same method used for every Mac build so far.

## Round 21 — FIFO costing (Mame 0.5.0; switched off for Avanza)
- Profit no longer depends on the item's own price: Gross profit = sales minus the FIFO cost of the stock sold. Each sale uses up the oldest stock first and takes that batch's purchase price. Editing an item (name, selling price, opening stock cost...) never rewrites the profit of past sales via its price; only real purchases and sales do. Recomputed from the records (src/utils/fifo.ts), so the existing history is costed with FIFO too.
- Purchases no longer overwrite the item's cost price; the purchase form no longer pre-fills the unit cost.
- Items: "Cost price" column removed (the Selling price column shows instead). New "Detail" button per item: every purchase batch - date, bought from, unit price, quantity bought, quantity left - with the batch that sells next marked. View menu: "Next to sell" (default, what is left in selling order) or "All purchases".
- Stock with no purchase behind it (typed in when the item was created) is an "Opening stock" batch at the item's "Opening stock cost" (the renamed cost field).
- Purchases list shows Unit cost; Sales list shows Unit price.
- Stock list PDF and Highest-stock-value sort use the remaining FIFO batches; the report PDF's cost of goods uses FIFO.

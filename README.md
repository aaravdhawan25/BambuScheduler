# Print Scheduler for a Bambu Lab A1

Upload a sliced print from your phone, schedule it (or print now), watch it live, and pause or stop it, from anywhere.
A small always-on computer at home (the **hub**) does all the talking to the printer.

```
[Browser: React PWA on Vercel] <--> [Supabase: Auth, Postgres, Realtime, Storage] <--> [Hub at home] --LAN--> [Bambu A1]
```

- The website never talks to the printer. It writes rows (jobs, commands) and reads status rows.
- The hub only makes **outbound** connections (to Supabase and the printer on your LAN). Nothing at home is exposed to the internet; no VPN or port forwarding.
- The printer's IP and access code live only in `hub/.env`.

> ## ⚠️ Safety: unattended printing is a fire risk
> Put a working smoke detector near the printer. Ideally, plug it into a smart plug you can switch off remotely.
> Never start a print unless you know the plate is empty: this app refuses to start anything until you tap **Plate is clear**,
> and every print that finishes (or fails, or is stopped) needs that confirmation again. Leave **auto-continue** off unless
> parts are removed automatically.

---

## Contents

- [Try it without any setup (demo mode)](#try-it-without-any-setup-demo-mode)
- [Repository layout](#repository-layout)
- [1. Supabase setup](#1-supabase-setup)
- [2. Deploy the website to Vercel](#2-deploy-the-website-to-vercel)
- [3. Printer: LAN Only Mode + Developer Mode](#3-printer-lan-only-mode--developer-mode)
- [4. Hub setup (Arduino UNO Q or any Linux box)](#4-hub-setup-arduino-uno-q-or-any-linux-box)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

Things that need confirming on real hardware are listed in [VERIFY.md](VERIFY.md).

---

## Try it without any setup (demo mode)

The website has a built-in demo backend with a simulated hub and printer (a 1-hour print takes about a minute):

```bash
cd web && npm install && npm run dev:demo
```

Open http://localhost:5173 and sign in with any email and a 4+ character password. Without `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` the app always runs in demo mode.

The hub also has a mock printer (`MOCK=1`). It needs a Supabase project (steps 1 and 4), but no printer.

## Repository layout

```
supabase/
  migrations/                 schema, RLS, triggers, storage bucket + policies, realtime
  setup_members.sql           one-off: give your two users their roles
  tests/rls.test.ts           RLS tests (real migrations on PGlite, no Docker)
  tests/live-smoke.mjs        read-only RLS checks against your real project
hub/
  bambu_hub/scheduler.py      job state machine, commands, hub_status
  bambu_hub/printer.py        Printer interface + MockPrinter
  bambu_hub/bambu.py          real A1 client (MQTT over TLS + implicit FTPS)
  bambu_hub/supa.py, store.py Supabase client (auth refresh, REST, storage)
  bambu-hub.service           systemd unit
web/
  src/routes/                 Login, Dashboard, NewPrint, Queue, History, Settings
  src/lib/api/                SupabaseApi (real) and DemoApi (simulated)
  src/lib/threemf.ts          reads .gcode.3mf files in the browser
  e2e/                        Playwright tests (run against demo mode)
```

---

## 1. Supabase setup

The free plan is enough.

1. **Create a project** at https://supabase.com. Note the **Project URL** and **anon public key**
   (Project Settings → API). You never need the service-role key for this app.
2. **Run the migration.** Either paste `supabase/migrations/20261115000001_init.sql` into the SQL editor and run it, or
   with the Supabase CLI:
   ```bash
   supabase link --project-ref YOUR-REF
   supabase db push
   ```
   This creates the tables, row level security, triggers, the private `prints` bucket (50 MB per file) and enables Realtime
   on `jobs`, `hub_status`, `commands` and `settings`.
3. **Turn off public sign-ups:** Authentication → Sign In / Providers → *Allow new users to sign up* → off.
   (Even if someone did sign up, they'd have no `members` row and RLS would show them nothing.)
4. **Create two users** in Authentication → Users → *Add user* (tick *Auto confirm*):
   - you (the owner), with a strong password;
   - the hub device account, e.g. `hub@yourdomain`, with a long random password.
5. **Give them roles:** edit the emails in `supabase/setup_members.sql` and run it in the SQL editor.
6. **Magic links (optional):** Authentication → URL Configuration → set *Site URL* to your Vercel URL.
7. **MFA:** not wired up yet. The app has no TOTP enrolment or code-challenge screen, so enabling MFA in Supabase
   would not be enforced by this app. Use a strong, unique owner password for now.
8. **Check RLS against the live project** (read-only, every check expects a refusal):
   ```bash
   cd supabase/tests && npm install
   SUPABASE_URL=https://xxx.supabase.co SUPABASE_ANON_KEY=eyJ... HUB_EMAIL=hub@... HUB_PASSWORD=... node live-smoke.mjs
   ```

Old print files are deleted by the hub 7 days after a job finishes. Thumbnails are kept for History.

## 2. Deploy the website to Vercel

1. Import the repository in Vercel and set **Root Directory** to `web`. The framework preset is Vite; build command
   `npm run build`, output `dist`.
2. Add the environment variables (Production and Preview):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
3. Deploy. `web/vercel.json` handles SPA routing and caching.
4. On your phone, open the site and use **Add to Home Screen**. It installs as an app (PWA).

Local development against your project: copy `web/.env.example` to `web/.env.local`, fill in the two values,
`npm run dev`.

## 3. Printer: LAN Only Mode + Developer Mode

The hub talks to the printer directly over your network, which needs *LAN Only Mode* with *Developer Mode*
(Bambu Cloud and Bambu Handy stop working while this is on). On the A1's screen (menu names vary a little by firmware):

1. **Settings → WLAN / Network:** connect the printer to the same network as the hub.
2. Turn on **LAN Only Mode**. The screen shows the printer's **IP address** and an 8-digit **Access Code**.
3. Turn on **Developer Mode** (on the same screen, below LAN Only Mode, on recent firmware). Without it the printer ignores
   third-party print commands.
4. Find the **serial number**: Settings → Device / About (or the sticker on the printer).
5. **Insert a microSD card.** Prints are copied to the card before they start.
6. Give the printer a fixed IP in your router (DHCP reservation) so the hub can always find it.

## 4. Hub setup (Arduino UNO Q or any Linux box)

Needs Python 3.11+, network access to Supabase and to the printer. On the UNO Q (Debian), over SSH:

```bash
sudo apt update && sudo apt install -y python3 python3-venv git
git clone <your repo> ~/BambuScheduler        # or copy the hub/ folder over
cd ~/BambuScheduler/hub
python3 -m venv .venv
.venv/bin/pip install -e .
cp .env.example .env && nano .env             # fill in Supabase + hub user + printer
```

**Test with the mock printer first** (`MOCK=1` in `.env`):

```bash
.venv/bin/python -m bambu_hub
```

Open the website: the hub shows as online, and a print you schedule "runs" for `MOCK_PRINT_SECONDS` and finishes.
Then set `MOCK=0` and run it again to talk to the real printer. Watch the log for `MQTT connected`.

**Run it as a service** (starts on boot, restarts on crash). Edit `User` and the paths in `bambu-hub.service` first:

```bash
sudo cp bambu-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bambu-hub
journalctl -u bambu-hub -f          # logs
```

The hub keeps running through Wi-Fi drops and Supabase outages (retries with backoff, refreshes its login) and picks up
where it left off after a restart.

---

## How it works

### A print's life

```
pending ──► uploading ──► printing ──► awaiting_clear ──► done
   │            │             │                ▲
   │            └─────────────┴──► attention ──┘   (Plate is clear)
   └──► missed           (owner can cancel pending / attention jobs)
```

- **pending**: waiting for its time. The hub starts it only when **all** of these hold: the time has come, the printer is
  idle or finished, no other job is active or needs attention, and the plate has been confirmed clear. If it's waiting, the
  app says why (for example *Waiting for plate to be cleared*).
- **missed**: it couldn't start within *Settings → Give up after N minutes* of its time, so it won't start unexpectedly late.
- **uploading**: claimed atomically (`UPDATE … WHERE stage = 'pending'`) so it can never start twice; the plate flag is
  set to not-clear; the file is downloaded and sent to the SD card; the start command goes out only if the printer is
  `IDLE`/`FINISH`.
- **printing**: watched until it ends. A `FINISH` only counts if the hub saw this print running, or 60 s after starting
  with this job's file name on the printer, so a leftover `FINISH` from the previous print can't fool it.
- **awaiting_clear**: finished; take the part off and tap **Plate is clear**.
- **attention**: something needs a human: upload/start failed, the printer reported a failure, it was stopped
  (from the app or the printer), it never started within 3 minutes, or the hub restarted mid-upload. **Plate is clear**
  resolves it.

### Commands

Pause, Resume, Stop and Plate-is-clear are rows in `commands`; the hub executes them within a few seconds and reports
the result (shown as a toast). Commands that reach the hub more than 5 minutes late (for example, it was offline) are
**not** executed, so a stale Stop never hits a later print. Stop needs a press-and-hold.

### Notifications (optional)

Install the [ntfy](https://ntfy.sh) app, subscribe to a hard-to-guess topic, and enter it in Settings. The hub sends:
print finished, needs attention, waiting for the plate, missed. "Hub offline" is shown in the app (banner after 45 s
without a heartbeat), because an offline hub can't send anything.

## Security model

The browser only ever has the anon key, so **row level security is the security boundary**. Summary:

| | anon | signed-in user without a role | owner | hub |
|---|---|---|---|---|
| jobs | nothing | nothing | read/create own; edit/cancel only while pending; delete only finished | read all; change only `stage`, `note`, `started_at`, `finished_at`, `remote_name`, `file_purged_at`, and only along allowed stage transitions; never insert/delete |
| commands | nothing | nothing | read; create (as pending) | read; mark handled (once) |
| hub_status | nothing | nothing | read | read/write |
| settings | nothing | nothing | read/update | read |
| members | nothing | nothing | own row | own row |
| storage `prints` | nothing | nothing | own folder: read/write/delete | read; delete only files of jobs finished more than 7 days ago |

Column and transition rules are enforced by triggers (`jobs_guard`, `commands_guard`) because RLS alone can't restrict
columns. `hub_status.last_seen` is stamped by the database clock. Tests: `supabase/tests/rls.test.ts` (36 cases) and the
live `live-smoke.mjs`. No service-role key is used anywhere. Printer secrets stay in `hub/.env` (git-ignored).

## Tests

```bash
# RLS (runs the real migrations in PGlite: no Docker, no Supabase project)
cd supabase/tests && npm install && npm test

# Hub: state machine on a fake clock with MockPrinter, Supabase client, printer protocol helpers
cd hub && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest && .venv/bin/mypy

# Website: unit tests, then end-to-end in demo mode (phone + desktop viewports)
cd web && npm install && npm test
npx playwright install chromium && npm run test:e2e
```

## Troubleshooting

- **"Your home hub is offline"**: check `journalctl -u bambu-hub -f`. `Invalid login credentials` means the hub email/password
  in `.env` is wrong; `Missing settings` lists what's missing.
- **Hub online but "Printer offline"**: wrong IP or access code, printer asleep, or LAN Only Mode off. The access code
  changes if you toggle LAN mode.
- **Job goes straight to "Needs attention" with an upload error**: no SD card, or the card is full.
- **"This account can't use the app"**: the user has no row in `members` (run `setup_members.sql`), or you signed in as the hub.
- **Upload fails with a size error**: the free plan limits files to about 50 MB. Fewer objects per plate helps.

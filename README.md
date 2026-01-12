# wolmgr

wolmgr tracks wake-on-LAN requests, stores every task row in **Turso (libSQL)**, and exposes a simple REST API so both the browser UI and automations can work from the same data.

## Architecture

- **React + polling UI:** the front-end polls `/api/wol/tasks` every few seconds to keep the task table fresh and calls the REST API to enqueue new wake requests.
- **Cloudflare Worker + Turso:** `_worker.ts` creates the `wol_tasks` table in Turso on first request, persists every change, and exposes endpoints that let UI (and optional RouterOS scripts) manage tasks.
- **bun waker (Docker):** `src/waker.ts` runs outside of Workers and polls Turso **every 10 seconds**, claims pending tasks, and sends WOL broadcasts directly. If RouterOS env vars are configured, it uses RouterOS API to proxy the WOL send.

## REST API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/wol/tasks` | Returns **all** tasks (used by the UI). |
| `POST` | `/api/wol/tasks` | Create a new task. Body: `{ "macAddress": "AA:BB:CC:DD:EE:FF" }`. |
| `PUT` | `/api/wol/tasks` | Update task status. Body: `{ "id": "abc", "status": "processing" }`. |
| `GET` | `/api/wol/tasks/pending` | Returns only pending tasks (used by RouterOS). |
| `POST` | `/api/wol/tasks/notify` | Mark the matching task (by `id` or `macAddress`) as `success` once the router sees it in the ARP table. |

All responses are JSON. Success responses return the affected `task` or `tasks` array, and failures return `{ "error": "..." }` with an appropriate HTTP status.

## RouterOS script (optional)

1. Copy `wol-routeros-script.rsc` onto the router and update the placeholder URLs at the top with your deployed worker (e.g., `https://your-namespace.pages.dev/api/wol/tasks`).
2. Adjust the polling interval (`INTERVAL`) as needed.
3. The script:
   - Fetches pending tasks from `/api/wol/tasks/pending`.
   - Sends the WOL packet for each MAC address.
   - Updates the task status to `processing` while waiting for the device to appear.
   - Watches `/ip arp` and calls `/api/wol/tasks/notify` immediately when the MAC is seen.
   - Falls back to a ping verification and marks the task `success`/`failed` if the ARP entry never appears.
4. Install the script in the scheduler and keep it running.

## Turso setup

1. Create a Turso database (or let CI create it for you).
2. Configure the Cloudflare Pages project with:
   - `TURSO_DATABASE_URL` (recommended: the **HTTP** URL, e.g. `https://<db>-<org>.turso.io`)
   - `TURSO_AUTH_TOKEN` (database auth token / JWT)
3. The worker auto-creates the `wol_tasks` table on first run, so no manual migrations are needed.

## CI/CD (GitHub Actions)

This repo includes a deploy workflow at `.github/workflows/deploy-cloudflare.yml` that:

- Ensures the Pages project exists.
- Ensures a Turso database exists (creates it if missing) using the **Turso Platform API**.
- Generates a fresh database auth token and configures the Pages project secrets.
- Builds and deploys the Pages project.

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` (API token with permissions for Cloudflare Pages)
- `CLOUDFLARE_ACCOUNT_ID`

Turso secrets:

- `TURSO_PLATFORM_API_TOKEN` (Platform API token)
- `TURSO_ORG_SLUG` (your org/user slug)
- `TURSO_DB_NAME` (e.g. `wolmgr`)
- `TURSO_GROUP` (optional; defaults to `default`)

## Local workflow

```bash
pnpm install        # install dependencies
pnpm build          # bundle the UI + worker
npx wrangler dev     # preview locally (Pages + Workers enabled)
npx wrangler deploy  # push to production
```

## bun waker (Docker)

The Docker image runs the bundled `waker` with bun, and **talks to Turso directly** (it does not call the Worker API).

Environment variables (minimum):

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

Optional RouterOS proxy:

- `ROUTEROS_ENABLED=true`
- `ROUTEROS_HOST`, `ROUTEROS_USER`, `ROUTEROS_PASSWORD`
- `ROUTEROS_PORT` (default `8728`), `ROUTEROS_TLS` (default `false`)
- `ROUTEROS_WOL_INTERFACE` (optional)

Example:

```bash
docker build -t wolmgr-waker .
docker run --rm \
   -e TURSO_DATABASE_URL=... \
   -e TURSO_AUTH_TOKEN=... \
   wolmgr-waker
```

## Notes

- The user request mentioned `libsql-client-ts`, but that exact package name is not available on npm; this project uses the official libSQL/Turso TypeScript client: `@libsql/client`.

Now the UI, worker, and (optional) RouterOS script all share the same Turso-backed state—no Durable Objects necessary.

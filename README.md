# Auto WOL Manager

Auto WOL Manager tracks wake-on-LAN requests, stores every task row in a Cloudflare D1 database, and exposes a simple REST API so both the browser UI and RouterOS scripts can work from the same data without using Durable Objects.

## Architecture

- **React + polling UI:** the front-end polls `/api/wol/tasks` every few seconds to keep the task table fresh and calls the REST API to enqueue new wake requests.
- **Cloudflare Worker + D1:** `_worker.ts` creates the `wol_tasks` table in the `WOL_DB` binding, persists every change, and exposes endpoints that let UI, RouterOS, and future automation manage tasks without Durable Object namespaces.
- **RouterOS scheduler script:** `wol-routeros-script.rsc` polls `/api/wol/tasks/pending`, sends the WOL packet, updates the task to `processing`, watches the ARP table, and notifies `/api/wol/tasks/notify` as soon as the device materializes.

## REST API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/wol/tasks` | Returns **all** tasks (used by the UI). |
| `POST` | `/api/wol/tasks` | Create a new task. Body: `{ "macAddress": "AA:BB:CC:DD:EE:FF" }`. |
| `PUT` | `/api/wol/tasks` | Update task status. Body: `{ "id": "abc", "status": "processing" }`. |
| `GET` | `/api/wol/tasks/pending` | Returns only pending tasks (used by RouterOS). |
| `POST` | `/api/wol/tasks/notify` | Mark the matching task (by `id` or `macAddress`) as `success` once the router sees it in the ARP table. |

All responses are JSON. Success responses return the affected `task` or `tasks` array, and failures return `{ "error": "..." }` with an appropriate HTTP status.

## RouterOS script

1. Copy `wol-routeros-script.rsc` onto the router and update the placeholder URLs at the top with your deployed worker (e.g., `https://your-namespace.pages.dev/api/wol/tasks`).
2. Adjust the polling interval (`INTERVAL`) as needed.
3. The script:
   - Fetches pending tasks from `/api/wol/tasks/pending`.
   - Sends the WOL packet for each MAC address.
   - Updates the task status to `processing` while waiting for the device to appear.
   - Watches `/ip arp` and calls `/api/wol/tasks/notify` immediately when the MAC is seen.
   - Falls back to a ping verification and marks the task `success`/`failed` if the ARP entry never appears.
4. Install the script in the scheduler and keep it running.

## D1 setup

1. Create a Cloudflare D1 database named `wol_tasks` (`npx wrangler d1 create wol_tasks`).
2. Bind it as `WOL_DB` in `wrangler.json`.
   - Wrangler requires a `database_id` for D1 bindings when deploying.
   - In CI, the GitHub Actions workflow auto-creates (or discovers) the D1 database and injects the correct `database_id` into a CI-only config file.
   - For local deploys, you can fetch the ID via `npx wrangler d1 info wol_tasks --json` and set `database_id` for the `WOL_DB` binding.
3. The worker auto-creates the table on first run, so no manual migrations are needed.

## CI/CD (GitHub Actions)

This repo includes a deploy workflow at `.github/workflows/deploy-cloudflare.yml` that:

- Ensures the Pages project exists.
- Ensures a D1 database named `wol_tasks` exists (creates it if missing).
- Generates a CI-only Wrangler config with the correct D1 `database_id`.
- Builds and deploys the Pages project.

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN` (API token with permissions for Pages + D1)
- `CLOUDFLARE_ACCOUNT_ID`

## Local workflow

```bash
pnpm install        # install dependencies
pnpm build          # bundle the UI + worker
npx wrangler dev     # preview locally (Pages + Workers enabled)
npx wrangler deploy  # push to production
```

Now the UI, worker, and RouterOS script all share the same D1-backed state—no Durable Objects necessary.

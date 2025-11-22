# CSI Centralized Email Management System (Local Scaffold)

Assumptions
- CommonJS with TypeScript for reliable local dev (ts-node-dev, Jest).
- Redis Stack provides RedisBloom (via `redis/redis-stack`).
- Supabase used only for auth; not wired yet in Phase 1.

Quick Start
- Copy `env.example` to `.env` and adjust values.
- Build and start services: `docker compose up --build`.
- Apply DB migrations (in another terminal): `docker compose run --rm app npm run migrate`.
- API runs on `http://localhost:3000`.
- WebSocket server on `ws://localhost:3001`.
- Frontend stub on `http://localhost:3002`.
- Optional pgAdmin on `http://localhost:5050`.

Environment Variables (.env)
- `DATABASE_URL=postgres://csi:csi_password@postgres:5432/csi_db`
- `REDIS_URL=redis://redis:6379`
- `API_PORT=3000` `WS_PORT=3001` `FRONTEND_PORT=3002`
- `NINJA_KEYS=key1,key2,key3` (mocked in Phase 1)
- `BLOOM_KEY=emails_bloom`
- `UPLOAD_DIR=/usr/src/app/uploads` `EXPORT_DIR=/usr/src/app/exports`
- `SUPABASE_URL` `SUPABASE_ANON_KEY` `SUPABASE_JWT_SECRET` (placeholders)

Scripts
- `npm run api` — start API (dev).
- `npm run worker` — start all workers (dev).
- `npm run ws` — start WebSocket server.
- `npm run migrate` — run SQL migrations in `migrations/`.
- `npm run test` — run unit tests (Jest).

API Endpoints
- `POST /upload` — body `{ emails: string[], submitter_id?: number, submitter_team_id?: number }`.
  - Creates a `batches` row and stores raw entries in `master_emails_temp`.
  - Enqueues a dedupe job.
- `GET /batches/:id` — returns batch row and counts across stages.
- Admin:
  - `GET /admin/batches` — list all batches with progress stats.
  - `GET /admin/employees` — summary per employee: uploads, validated counts.
  - `GET /admin/rules` — filter by `scope`, `employee_id`, `team_id`.
  - `POST /admin/rules` — create rule `{ scope, employee_id, team_id, contains[], endswith[], domains[], excludes[], priority }`.
  - `PUT /admin/rules/:id` — update arrays and priority.
  - `DELETE /admin/rules/:id` — delete rule.
  - `GET /admin/unsubscribes/emails|domains` — view lists.
  - `POST /admin/unsubscribes/emails|domains` — bulk upload arrays `{ emails|domains: string[], user_id? }`.

Pipeline Workers (BullMQ)
- `dedupeWorker` — normalize, RedisBloom pre-check, `INSERT ... ON CONFLICT DO NOTHING` into `master_emails`, enqueue `filter`.
- `filterWorker` — merge employee/team/global rules, write `filter_emails` flags, skip downstream if unsubscribed, enqueue `personal` otherwise.
- `personalWorker` — separate public-provider domains into `personal_emails`, else enqueue `validation`.
- `validationWorker` — validate via Ninja API using rotating key manager, write to `validation_results`.

WebSocket
- Emits `batch_progress` events from all stages, e.g.:
  - `{"batchId":1,"stage":"dedupe_progress","processed":1000}`
  - `{"stage":"filter","status":"running","master_id":123}`
  - `{"stage":"personal","status":"excluded|passed","master_id":123}`
  - `{"stage":"validation","status":"running","master_id":123}`
 - Subscribe from clients via Socket.IO.

Sample Data
- Generate JSON file: `node scripts/sample-data-generator.js 200000`.
- Then upload via `POST /upload` with the JSON `emails` array.

Testing
- `npm run test` runs Jest unit tests for normalization, rules, unsubscribe filtering, and Ninja key rotation.

Notes
- Jobs are idempotent and process in chunks; staging rows are deleted as chunks complete.
- RedisBloom reduces DB hits; DB unique index is authoritative.
- Personal-domain list is in `public_provider_domains`; seed as needed.
- Unsubscribe checks are applied in filtering stage using email and domain lists.
- Ninja API keys rotate with cooldown on errors to avoid rate limits.
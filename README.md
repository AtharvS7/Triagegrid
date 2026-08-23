# TriageGrid

Real-time, offline-tolerant coordination for mass-casualty and multi-incident
events. Dispatchers, field responders, and hospitals share one live operating
picture; citizen reports flow in without accounts; every state transition lands
in a tamper-evident audit log.

## Stack (100% free tier)

| Layer | Tech |
|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript, deployed as a Render Web Service |
| Database | Supabase Postgres 15 + PostGIS |
| Auth | Supabase Auth (email/password; citizens need no account) |
| Realtime | Supabase Realtime (`postgres_changes`, RLS-scoped per subscriber) |
| Storage | Supabase Storage — **private** `incident-photos` bucket, signed URLs |
| Scheduled work | pg_cron + pg_net → `match-batch` Edge Function (Deno) |
| Maps/ETA | No paid provider: haversine + configurable speed factor; Leaflet-compatible |

## Architecture in one paragraph

The Next.js frontend talks directly to Supabase for data/auth/realtime.
Everything security-critical lives server-side: Row-Level Security is the
authorization boundary; business logic runs in SECURITY DEFINER Postgres
functions with explicit role checks (scoring, claim arbitration, state machine,
diversion). Resource claiming is concurrency-safe via unit-row `FOR UPDATE`
plus two partial unique indexes — double-dispatch is physically impossible,
not just UI-prevented. The field PWA queues mutations in IndexedDB with
idempotency keys and reconciles through `/api/sync`, which replays them through
the *same* role-checked RPCs used online; conflicts follow a per-field policy
matrix (see `supabase/migrations/00004_field_sync_rpcs.sql`).

## Quick start (local)

Prereqs: Node 20+, Docker Desktop, Supabase CLI.

```bash
npm install
supabase start          # pulls images, applies migrations + seed
cp .env.example .env.local
# fill NEXT_PUBLIC_* + SUPABASE_SERVICE_ROLE_KEY from `supabase status`
npm run dev             # http://localhost:3000
```

### Seeded identities (local only — passwords are dev defaults)

| Email | Role | Password |
|---|---|---|
| admin@triagegrid.test | System Admin | password123 |
| dispatch@triagegrid.test | Dispatcher | password123 |
| field@triagegrid.test / field2@… | Field responders | password123 |
| hospital@triagegrid.test | Hospital Admin | password123 |

Citizens use `/citizen` without an account and track via `/track`.

## Deploying

1. **Supabase project** (free tier):
   - `supabase link --project-ref <ref>` then `supabase db push` to apply
     migrations 0001–0004.
   - Set config keys:
     ```sql
     update public.config set value = '"https://<ref>.supabase.co/functions/v1/match-batch"'
       where key = 'functions.match_batch_url';
     ```
   - Deploy the matcher: `supabase functions deploy match-batch`, then
     `supabase secrets set MATCH_BATCH_SECRET=<random>` AND the same value in
     the DB config key `functions.match_batch_secret`.
   - Provision one agency row + personnel/hospitals/units (Studio or SQL).
2. **Render**: new Blueprint → point at this repo; set the three env vars from
   `.env.example` in the dashboard (see `render.yaml`).

## Tests

```bash
npm run test        # Vitest: solver units + DB suites (needs `supabase start`)
```

- **Scoring** — representative severity inputs incl. numeric multipliers and
  override retention (`tests/db/scoring.test.ts`)
- **Concurrency (FR-6)** — 10 simultaneous claims on one unit/incident pair;
  asserts exactly one success and typed conflicts for the rest
  (`tests/db/concurrency.test.ts`)
- **Offline sync (FR-8)** — lifecycle replay, triage MANUAL-SURFACE conflict,
  server-authoritative invalid transitions, FR-7 escalation sweep
  (`tests/db/offline_sync.test.ts`)
- **RLS per role** — allowed AND denied paths for anon/field/dispatcher/
  hospital_admin/admin, cross-agency isolation, grant-level audit immutability
  (`tests/db/rls.test.ts`)

## Security posture (OWASP Top 10 mapping)

- **A01 Broken access control** — RLS on every table; zero direct UPDATE grants
  on operational tables; privileged mutations only via role-checked SECURITY
  DEFINER RPCs; internal helper functions have EXECUTE revoked from client roles.
- **A02 Crypto failures** — tracking codes are 22-char base62 from
  `gen_random_bytes` (~2^130); audit chain is SHA-256 hash-linked; no secrets in
  code (env vars only).
- **A03 Injection** — all queries parameterized (RPC args / supabase-js);
  user text sanitized (control/invisible Unicode stripped) before storage;
  React escaping at render.
- **A04 Insecure design** — state machine + diversion/capacity rules enforced
  in the database, not the UI; rate limits on all unauthenticated surfaces.
- **A05 Misconfiguration** — private storage bucket; service_role grants
  restored explicitly but audit_log kept INSERT/SELECT-only even for it.
- **A07 Auth failures** — Supabase Auth manages sessions/rotation; seeded test
  credentials exist only in local seeds.
- **A08 Integrity** — append-only audit log with chain verifier
  (`verify_audit_chain()`), surfaced in the admin panel.
- **A09 Logging failures** — every incident/claim/triage/hospital transition
  audited with before/after snapshots and actor identity.
- **A10 SSRF** — no user-supplied URLs fetched server-side; outbound calls go
  only to the configured Edge Function URL via pg_net.

## Key design decisions (short form)

- **FR-3 matching**: batched weighted bipartite assignment (Hungarian/JV) every
  60s (config), immediate pass for critical-tier incidents; proposals finalize
  through the same locked claim path so stale pairs fail safely.
- **FR-6 claims**: unit-row lock → precondition re-check → insert guarded by
  partial unique indexes. Typed SQLSTATE errors (TG100–TG111).
- **FR-8 sync**: per-field conflict policies — status = server-authoritative
  with ordered replay; triage vitals = manual-surface (never silent); position =
  LWW behind a GPS drift guard; destination = LWW (single-writer crew).
- **FR-7 escalation**: minute-cron sweep bumps tiers past SLA, notifies
  dispatchers, triggers re-match; separate health check catches overdue/stuck
  matcher batches and stranded incidents even when the heartbeat lies.

See migration headers for the full documented reasoning.

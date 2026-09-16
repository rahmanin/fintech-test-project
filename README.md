# Program Capacity & Invoice Reservation

Take-home assignment. See [`TASK.md`](./TASK.md) for the problem statement and
[`PLAN.md`](./PLAN.md) for the analysis, assumptions and design decisions.

## Status

| Phase | Content | State |
|-------|---------|-------|
| 0 | Analysis and plan | done |
| 1 | NestJS skeleton, Docker Compose (Postgres + Kafka), migrations step, `/health`, Swagger | done |
| 2 | `money` + `fx` modules | — |
| 3 | Programs and reservations domain, row locks, concurrency tests | done |
| 4 | REST API, JWT auth, three-level validation | done |
| 5 | Treasury Kafka consumer, reconciliation | done |
| 6 | Full README: API walk-through, Kafka examples, consistency model | — |

## Quick start

```bash
docker compose up --build
```

This starts Postgres, a single-node Kafka (KRaft), creates the
`treasury.program-capacity` topic, applies database migrations, and starts the
API on http://localhost:3000.

Host ports: API `3000`, Postgres `5433` (not 5432, to avoid colliding with a
local Postgres), Kafka `29092`. Override any of them with `APP_HOST_PORT`,
`POSTGRES_HOST_PORT`, `KAFKA_HOST_PORT` in a `.env` file next to
`docker-compose.yml`.

- Health: http://localhost:3000/health
- Swagger UI: http://localhost:3000/docs

## Authentication

Every business endpoint requires `Authorization: Bearer <token>`. Get a token
with the development client credentials from `docker-compose.yml`:

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/token \
  -H 'content-type: application/json' \
  -d '{"clientId":"demo-client","clientSecret":"demo-client-secret-change-me"}'
```

In Swagger, click **Authorize** and paste the `accessToken`. Only `/health`,
`/docs` and the token endpoint itself are public.

## Quick tour

```bash
TOKEN=...   # from the call above
B=http://localhost:3000/api/v1

# Program with current availability (PRG-DEMO is seeded: USD, 10,000,000.00)
curl -s -H "Authorization: Bearer $TOKEN" $B/programs/PRG-DEMO

# Reserve an EUR invoice against the USD program (201; replaying it returns 200)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  $B/programs/PRG-DEMO/reservations \
  -d '{"invoiceId":"INV-1001","amount":"1000.00","currency":"EUR"}'

# Release it after repayment (idempotent)
curl -s -X POST -H "Authorization: Bearer $TOKEN" $B/programs/PRG-DEMO/reservations/INV-1001/release

# List reservations, optionally ?status=ACTIVE|RELEASED
curl -s -H "Authorization: Bearer $TOKEN" "$B/programs/PRG-DEMO/reservations?status=RELEASED"
```

### Telling a first call from a repeat

Reserve and release are idempotent: repeating either returns the same
reservation as the original call. So that a retry is never mistaken for a
first-time success, every response says what *this* call did, in `outcome`,
the first field of the body:

```json
{
  "outcome": "ALREADY_RESERVED",
  "programId": "PRG-DEMO",
  "invoiceId": "INV-1001",
  "reservedAmount": "1080.00"
}
```

| Call | Status | `outcome` | `Idempotent-Replay` |
|------|--------|-----------|---------------------|
| Reserve an invoice for the first time | 201 | `CREATED` | `false` |
| Repeat the same reserve | 200 | `ALREADY_RESERVED` | `true` |
| Repeat with a different amount | 409 | absent | absent |
| Release for the first time | 200 | `RELEASED` | `false` |
| Repeat the release | 200 | `ALREADY_RELEASED` | `true` |

A repeat stays a **2xx**: the caller asked for the invoice to be reserved and
it is reserved, so a retry after a lost response must look like the success
it is. Returning 4xx would make a client that retries on timeout treat a
correct outcome as a failure. The full body is returned for the same reason:
a client that lost the first response gets the amount and the frozen rate
without a second call.

A repeat with a *different* amount is not a replay but a client bug, so it
stays `409 IDEMPOTENCY_CONFLICT` with no outcome. The header duplicates the
signal for machine clients that read only metadata; list items carry no
`outcome`, since no call outcome applies to them.

Errors always have the shape `{ "code": "...", "message": "...", "details": {...} }`.

## Treasury capacity feed (Kafka)

Treasury owns program limits and publishes them to `treasury.program-capacity`.
The service only consumes; it publishes nothing. Two message types, both
carrying **absolute state** plus a monotonic per-program `version`:

```jsonc
// CAPACITY_UPDATED — one program, keyed by programId
{
  "eventId": "…", "type": "CAPACITY_UPDATED", "occurredAt": "2026-09-15T10:00:00Z",
  "payload": { "programId": "PRG-DEMO", "version": 4, "currency": "USD", "totalLimit": "9000000.00" }
}

// PROGRAM_SNAPSHOT — bulk reconciliation, many programs, sent unkeyed
{
  "eventId": "…", "type": "PROGRAM_SNAPSHOT", "occurredAt": "2026-09-15T10:00:00Z",
  "programs": [
    { "programId": "PRG-DEMO", "version": 5, "currency": "USD", "totalLimit": "8000000.00" },
    { "programId": "PRG-EUR",  "version": 1, "currency": "EUR", "totalLimit": "2500000.00" }
  ]
}
```

A snapshot carries **no invoice-level data**: TASK.md never says treasury
knows about reservations, so "full state" means a program's currency and
limit. A program absent from a snapshot is left untouched.

Publish messages locally:

```bash
npm run treasury:publish -- update PRG-DEMO 4 9000000.00 USD
npm run treasury:publish -- snapshot PRG-DEMO:5:8000000.00:USD PRG-EUR:1:2500000.00:EUR
```

Handling guarantees:

- **Idempotent**: an entry is applied only when its `version` is newer than
  the stored one, checked while holding the program row lock. Duplicate
  delivery and out-of-order delivery are both no-ops.
- **One acknowledgement per message**: a bulk snapshot is one Kafka message,
  so the offset is committed only after every entry has been handled. Each
  entry commits in its own transaction, and a heartbeat every 50 entries
  keeps a long batch from triggering a rebalance.
- **Poison-safe**: unparsable messages and permanently invalid entries are
  logged and skipped, never retried, so one bad message cannot block a
  partition. Database failures are treated as transient and re-thrown, which
  leaves the offset uncommitted and the message to be redelivered.

## Local development without Docker for the app

```bash
cp .env.example .env
docker compose up postgres kafka kafka-init   # infrastructure only
npm install
npm run migrate
npm run start:dev
```

## Tests

```bash
npm test          # unit tests, no infrastructure needed
npm run lint
```

Integration tests run against a throwaway Postgres (its own container and
port, so they never touch the dev database):

```bash
docker compose -f docker-compose.test.yml up -d
npm run test:integration
```

They cover the service layer (reserve / release round trip, idempotent
replays and conflicts, FX conversion with the frozen rate, the concurrency
guarantee: 25 parallel reservations against a limit that fits 10, exactly 10
succeed) and the HTTP layer end to end (authentication, request validation,
every error code).

## Stack

Node.js 22, TypeScript, NestJS 11, TypeORM, PostgreSQL 16, Kafka 4 (KRaft), Jest.

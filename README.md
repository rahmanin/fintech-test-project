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
| 5 | Treasury Kafka consumer, reconciliation | — |
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

Errors always have the shape `{ "code": "...", "message": "...", "details": {...} }`.

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

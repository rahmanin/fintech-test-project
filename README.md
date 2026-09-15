# Program Capacity & Invoice Reservation

Take-home assignment. See [`TASK.md`](./TASK.md) for the problem statement and
[`PLAN.md`](./PLAN.md) for the analysis, assumptions and design decisions.

## Status

| Phase | Content | State |
|-------|---------|-------|
| 0 | Analysis and plan | done |
| 1 | NestJS skeleton, Docker Compose (Postgres + Kafka), migrations step, `/health`, Swagger | done |
| 2 | `money` + `fx` modules | — |
| 3 | Programs and reservations domain, row locks, concurrency tests | — |
| 4 | REST API, JWT auth, three-level validation | — |
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

## Stack

Node.js 22, TypeScript, NestJS 12, TypeORM, PostgreSQL 16, Kafka 4 (KRaft), Jest.

# Program Capacity & Invoice Reservation

A financing program has a credit limit. Approving an invoice for early payment
reserves part of that limit; repayment releases it. This service is the ledger
of that capacity: it accepts reservations, processes releases, exposes current
availability, and keeps program limits in sync with an external treasury system
over Kafka. Programs and invoices may be in different currencies.

[`TASK.md`](./TASK.md) is the problem statement. [`PLAN.md`](./PLAN.md) holds
the full analysis written before any code: requirements versus assumptions,
schema, API, Kafka semantics, concurrency, and what was deliberately left out.

Where to look in the code:

| Area                                                              | File                                                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capacity ledger: reserve, release, availability, treasury updates | [`src/programs/capacity.service.ts`](./src/programs/capacity.service.ts)                                                                             |
| Money and FX arithmetic (`bigint`, no floats)                     | [`src/money/`](./src/money), [`src/fx/`](./src/fx)                                                                                                   |
| Treasury message handling                                         | [`src/treasury/`](./src/treasury)                                                                                                                    |
| HTTP surface and error mapping                                    | [`src/programs/programs.controller.ts`](./src/programs/programs.controller.ts), [`src/common/api-error.filter.ts`](./src/common/api-error.filter.ts) |

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

# Reserve an EUR invoice against the USD program
# 201 with outcome CREATED; replaying it returns 200 with outcome ALREADY_RESERVED
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
first-time success, every response says what _this_ call did, in `outcome`,
the first field of the body:

```json
{
  "outcome": "ALREADY_RESERVED",
  "programId": "PRG-DEMO",
  "invoiceId": "INV-1001",
  "reservedAmount": "1080.00"
}
```

| Call                                  | Status | `outcome`          | `Idempotent-Replay` |
| ------------------------------------- | ------ | ------------------ | ------------------- |
| Reserve an invoice for the first time | 201    | `CREATED`          | `false`             |
| Repeat the same reserve               | 200    | `ALREADY_RESERVED` | `true`              |
| Repeat with a different amount        | 409    | absent             | absent              |
| Release for the first time            | 200    | `RELEASED`         | `false`             |
| Repeat the release                    | 200    | `ALREADY_RELEASED` | `true`              |

A repeat stays a **2xx**: the caller asked for the invoice to be reserved and
it is reserved, so a retry after a lost response must look like the success
it is. Returning 4xx would make a client that retries on timeout treat a
correct outcome as a failure. The full body is returned for the same reason:
a client that lost the first response gets the amount and the frozen rate
without a second call.

A repeat with a _different_ amount is not a replay but a client bug, so it
stays `409 IDEMPOTENCY_CONFLICT` with no outcome. The header duplicates the
signal for machine clients that read only metadata; list items carry no
`outcome`, since no call outcome applies to them.

### Errors

Every error has the same shape, whatever raised it:

```json
{
  "code": "INSUFFICIENT_CAPACITY",
  "message": "Program PRG-DEMO: requested 600.00 USD, available 500.00 USD",
  "details": { "requested": "600.00", "available": "500.00", "currency": "USD" }
}
```

| Code                    | Status | When                                                                                                                        |
| ----------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`      | 400    | Request shape is wrong: unknown field, numeric amount, malformed currency                                                   |
| `INVALID_AMOUNT_FORMAT` | 400    | Amount is not a plain decimal string. Mapped defensively; in practice DTO validation rejects it first as `VALIDATION_ERROR` |
| `INVALID_AMOUNT_SCALE`  | 400    | More decimals than the currency has, e.g. `"10.005"` in USD                                                                 |
| `AMOUNT_OUT_OF_RANGE`   | 400    | Amount does not fit a 64-bit integer in minor units                                                                         |
| `UNAUTHORIZED`          | 401    | Missing, malformed or expired bearer token                                                                                  |
| `PROGRAM_NOT_FOUND`     | 404    | No such program                                                                                                             |
| `RESERVATION_NOT_FOUND` | 404    | Releasing an invoice that was never reserved                                                                                |
| `INSUFFICIENT_CAPACITY` | 409    | Converted amount exceeds what is available                                                                                  |
| `IDEMPOTENCY_CONFLICT`  | 409    | Same invoice, different amount or currency                                                                                  |
| `UNSUPPORTED_CURRENCY`  | 422    | Unknown currency, or no FX rate for the pair                                                                                |
| `AMOUNT_TOO_SMALL`      | 422    | Converts to zero in the program currency after rounding                                                                     |
| `INTERNAL_ERROR`        | 500    | Anything unexpected; the internal message is never leaked                                                                   |

Validation happens at three levels, each catching a different failure: request
shape in the DTOs, business rules inside the transaction while holding the
program row lock, and CHECK constraints in the database as a last line of
defence.

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

## Consistency model, and its one real limitation

Two systems hold two halves of the truth:

- **Treasury owns the limit** of a program, and its existence and currency.
  It publishes them over Kafka.
- **This service owns the reservations.** Treasury never sees invoice-level
  data, so nothing about reservations can arrive from outside.

Because those halves meet asynchronously, the service is **eventually
consistent with treasury**, and that has a consequence worth stating plainly.

**The stale-capacity window.** Suppose treasury publishes a cut from
10,000,000 to 8,000,000. Until the consumer has processed that message, the
API still sees 10,000,000 and can accept a reservation treasury would have
refused. The window is exactly the consumer lag: milliseconds normally,
minutes if the consumer is down, unbounded if the broker is unreachable.

**This is inherent, not an oversight.** Kafka is asynchronous by definition.
The only way to close the window is a synchronous call to treasury on every
reservation, which the assignment does not offer and which would make every
approval depend on treasury being up.

**What it costs, and why it self-corrects.** When the update lands, the limit
drops, existing reservations stay, and `available` simply goes negative. New
reservations are then refused until enough releases arrive. Nothing already
approved is cancelled automatically: reversing an approved early payment is a
business decision, not something a capacity ledger should take on its own. The
overshoot is bounded by whatever was accepted during the lag window, and it
disappears as invoices are repaid. Treasury and this service never disagree
about reservations, because only this service holds them.

**What the API gives a client to judge freshness.** Every program response
carries `treasuryVersion`, the last version applied for that program, so a
caller can correlate it with what treasury believes it has sent.

Not built, and why:

- **Consumer lag monitoring and alerting.** The right operational answer, but
  it belongs to the deployment, not to this module.
- **A freshness circuit breaker** that refuses reservations when no treasury
  message has arrived for too long. Meaningful because snapshots are periodic,
  so silence is a real signal. Left out as scope the assignment does not ask
  for; it would be a config flag defaulting to off.
- **A safety buffer** on the limit. That is a risk-appetite decision for the
  business, not an engineering one.

## Assumptions

`TASK.md` leaves these open. Each was decided deliberately rather than
silently; the reasoning is in [`PLAN.md`](./PLAN.md).

| #   | Assumption                                                                                                                                                                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | One reservation per invoice per program, for the full invoice amount. No partial reservations or releases.                                                                                                                                                                                                                                   |
| 2   | `invoiceId` is the idempotency key. It is supplied by the caller because the invoice exists before this service is involved; it must be unique within a program.                                                                                                                                                                             |
| 3   | Availability is reported in the program currency only.                                                                                                                                                                                                                                                                                       |
| 4   | The FX rate is fetched once, at reservation time, frozen on the row, and the release returns exactly the frozen converted amount. Re-converting later would make the ledger drift.                                                                                                                                                           |
| 5   | FX rates come from configuration (`FX_RATES`) behind an `FxRateProvider` interface. No external FX API, as instructed. Each direction is configured explicitly; inverse rates are not derived, because deriving them would round the rate itself.                                                                                            |
| 6   | Conversion rounds half-up to the program currency's minor unit.                                                                                                                                                                                                                                                                              |
| 7   | Treasury messages carry absolute state plus a monotonic per-program `version`. This is the contract that makes duplicate, stale and out-of-order delivery safe without an extra table. In a real integration it would be confirmed with the treasury team; without a version, deduplication would need a `processed_events(event_id)` table. |
| 8   | Programs are created only by treasury messages. A seed migration adds one demo program so the service is usable immediately.                                                                                                                                                                                                                 |
| 9   | A limit may drop below the reserved amount. `available` goes negative, new reservations are refused, releases still work, nothing is auto-cancelled.                                                                                                                                                                                         |
| 10  | A program absent from a snapshot is left untouched. Absence is not an instruction, and the task defines no program closure.                                                                                                                                                                                                                  |
| 11  | A program's currency never changes. A message claiming a different currency is refused and logged, because stored reservations are denominated in the program currency.                                                                                                                                                                      |
| 12  | "Real time" means synchronous reads of committed state. No push channel.                                                                                                                                                                                                                                                                     |
| 13  | One API client identity from configuration, no roles. The task asks for authentication, not authorisation.                                                                                                                                                                                                                                   |
| 14  | Amounts and FX rates travel as decimal strings, never JSON numbers, and are stored as `BIGINT` minor units and `NUMERIC(20,10)`.                                                                                                                                                                                                             |

One deviation from "all endpoints must be authenticated" is deliberate:
`GET /health` (probes cannot carry a token), `POST /auth/token` (it issues
them) and `GET /docs` (it serves the API description, not data) are public.
Every endpoint that reads or writes business state is authenticated.

## What this service deliberately does not do

Each of these was considered and rejected as scope the assignment does not
call for, not overlooked:

- **No event sourcing, CQRS or read models.** The reservations table is the
  ledger; availability is derived from it under the same lock that guards
  writes.
- **No transactional outbox and no produced events.** This service only
  consumes from Kafka.
- **No Redis or distributed locks.** A Postgres row lock is transactional and
  sufficient, and it serialises API writes and treasury updates together.
- **No exactly-once Kafka semantics, schema registry or dead-letter topic.**
  At-least-once delivery with an idempotent handler is the standard answer;
  rejected messages are logged with their topic, partition and offset.
- **No materialised `reserved` counter.** Summing active rows under the lock
  is exact and removes a whole class of drift bugs. Cache it when it is
  measured to matter.
- **No external FX API, no cross-rate derivation, no partial financing.**
- **No RBAC, refresh tokens or user management.**
- **No Kubernetes.** Docker Compose is what "runnable locally" needs.

## What I would do next

In rough order of value:

1. **Pagination on the reservations list.** Fine for a demo, not for a program
   with thousands of invoices.
2. **Metrics and consumer-lag alerting**, which is what makes the consistency
   limitation above operationally visible.
3. **RS256 with keys from an identity provider's JWKS endpoint** instead of a
   shared HS256 secret. Only the guard's verification options change.
4. **Structured JSON logging with a correlation id** carried from the HTTP
   request and from the Kafka `eventId`.
5. **A load test of the reservation path**, to find where the per-program row
   lock actually becomes a bottleneck rather than guessing.

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

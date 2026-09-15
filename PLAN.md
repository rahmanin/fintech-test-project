# PLAN — Program Capacity & Invoice Reservation

Status: **v2, approved decisions incorporated. No implementation has started.**

Source of truth for requirements: `TASK.md`. Engineering constraints: `CLAUDE.md`.
Stack: Node.js 20 + TypeScript + NestJS + TypeORM + PostgreSQL + Kafka (kafkajs) + Docker Compose + Jest + Swagger.

Revision log:
- v1 (2026-09-15): initial analysis.
- v2 (2026-09-15): reservations come only from the API, snapshot carries aggregate capacity only; schema cut to two tables; FX rate as fixed-point `bigint`; `POST /programs` and `/availability` removed; seed migration + Swagger added; freshness circuit breaker out of scope; three-level validation; one Kafka ack per message; TypeORM chosen.
- v2.2 (2026-09-15, second pre-commit review): program creation race closed with `INSERT ... ON CONFLICT DO NOTHING` before the lock; `version` must be a safe integer (number or digit string) and is compared as `bigint`; empty snapshot is a no-op; topic creation, `fromBeginning`, consumer group and migration step added to phase 1; SHA-256 before `timingSafeEqual`; replay compares the request, not the converted result.
- v2.1 (2026-09-15, pre-commit review): bulk messages are unkeyed and ordering rests on `version`, not partitioning; consumer heartbeat inside the bulk loop; BIGINT range check in `Money.parse`; `version >= 1`; programs absent from a snapshot are untouched (A14); availability read in one SQL statement; transactional-manager rule; inverse FX derivation removed; reservation response body fixed; public endpoints listed as an explicit deviation; `eventId`/`occurredAt` optional; explicit Kafka error policy; READ COMMITTED stated.

---

## 1. The business problem in plain words

A funder (bank / treasury) gives a **financing program** a pot of money, the
**credit limit** (e.g. 10,000,000 USD). Suppliers submit invoices. When an
invoice is **approved for early payment**, part of the pot is set aside for it
(a **reservation**). When the buyer **repays** the invoice, that part goes back
into the pot (a **release**).

This service is the gatekeeper of the pot. It must:

1. never set aside more than the pot has (no oversubscription);
2. tell clients, right now, how much is still available;
3. keep the size of the pot in sync with the **treasury system**, which owns
   the limit and sends it over Kafka, both as incremental updates and as
   periodic bulk snapshots.

Complication: the pot is in one currency, invoices may be in another, so every
reservation is converted into the program currency before it is counted.

Division of authority, stated once and used everywhere:

- **Treasury is the authority for the limit** of a program (and for the
  program's existence and currency).
- **This service is the authority for reservations.** Treasury never sends
  invoice-level data; TASK.md does not say it does.

---

## 2. Explicit requirements vs. assumptions

### 2.1 Explicit (from TASK.md)

| # | Requirement |
|---|-------------|
| R1 | A program has a total credit limit. |
| R2 | Approving an invoice reserves part of the capacity. |
| R3 | Repaying an invoice releases the reserved amount. |
| R4 | The module tracks this in real time: accept reservations, process releases, expose current availability. |
| R5 | Capacity data also arrives from an external treasury system via Kafka. |
| R6 | Treasury sends periodic bulk reconciliation messages carrying a program's full state. |
| R7 | Programs and invoices may be in different currencies. |
| R8 | All endpoints are authenticated. |
| R9 | The service runs locally. |
| R10 | Production quality; assumptions and trade-offs documented. |

### 2.2 Engineering constraints (from CLAUDE.md, plus additions agreed on 2026-09-15)

No float money; no oversubscription under concurrency; idempotent reserve and
release; duplicate-safe Kafka handling; async treasury consistency documented;
FX behind a simple abstraction, no external FX API; JWT; tests for important
business cases; no Redis / microservices / CQRS / event sourcing.
Validation at three levels (HTTP DTO, business rules, DB constraints) plus
Kafka payload validation, kept minimal and aligned with TASK.md. A bulk Kafka
message is acknowledged only after the whole payload is handled.

### 2.3 Assumptions (decisions TASK.md does not make; all repeated in README)

| # | Assumption | Why this choice |
|---|------------|-----------------|
| A1 | One reservation per invoice per program, for the full invoice amount. No partial reservations or releases. | Not mentioned in the task; adding them multiplies state transitions. |
| A2 | `invoiceId` is the idempotency key for reserve and release. Same invoice + same amount and currency → `200` with the existing reservation; different amount or currency → `409 IDEMPOTENCY_CONFLICT`. The comparison is on the **request** (invoice amount and currency), not on the converted amount, so a replay after an FX config change still returns the original reservation with its frozen rate. | Retries must be safe; a silent overwrite would hide client bugs. |
| A3 | Availability is reported in the **program currency** only. | Converting availability into other currencies is a display concern. |
| A4 | FX rate is looked up **at reservation time**, frozen on the reservation row; the **release returns exactly the frozen converted amount**. | The ledger closes: what was subtracted is what comes back. Re-converting at release would leak or over-return capacity. |
| A5 | FX rates come from a static, configurable table behind an `FxRateProvider` interface. No external API. | Required by CLAUDE.md. |
| A6 | Rounding after conversion: **half-up to the program currency's minor unit** (2 dp for USD/EUR/GBP, 0 dp for JPY). | Deterministic and standard for invoices. `ceil` (always over-reserve) noted as an alternative. |
| A7 | Treasury messages carry **absolute state** (the full limit, never a delta) and a **monotonically increasing per-program `version`**, sent as a JSON integer within the safe-integer range or as a decimal string; it is compared as `bigint`. | TASK.md defines neither ordering nor deduplication metadata. These two assumptions make duplicates, redelivery and out-of-order delivery safe with no extra tables. In a real integration this contract would be confirmed with the treasury team before implementation. Fallback if no version exists: a `treasury_events(event_id PK)` table for deduplication and reliance on partition ordering by `programId`. |
| A8 | Programs are **created only by treasury messages**. There is no REST endpoint to create programs. A seed migration inserts one demo program so the service is usable right after `docker compose up`. | Treasury owns programs; a creation endpoint would be an invented requirement. |
| A9 | The limit can drop below the reserved amount (treasury reduces it). Then `available` is negative, new reservations are rejected, releases still work, nothing is auto-cancelled. | Cancelling approved early payments is a business decision, not a capacity-service decision. |
| A10 | "Real time" = synchronous REST reads of committed state. No push. | Nothing in the task asks for push. |
| A11 | A single API client identity (client credentials from env), no roles. | Task only demands "authenticated". |
| A12 | Amounts and rates in JSON and config are decimal **strings**, never numbers. | JSON numbers are IEEE doubles. |
| A13 | Changing a program's currency is not supported; a treasury message with a different currency for an existing program is rejected and logged. | Existing reservations are stored in the old currency; TASK.md describes no such scenario. |
| A14 | A program that exists locally but is absent from a bulk snapshot is left untouched. | Absence is not an instruction. TASK.md defines no program closure or deletion; inventing "absent = closed" could freeze a live program because of a partial snapshot. |

---

## 3. Ambiguities found in the task and how each is resolved

1. **Who creates programs and changes limits.** → Treasury, via Kafka (A8).
2. **What treasury sends.** → Only program capacity: currency + total limit, as single updates and as bulk snapshots. No invoice-level data (§1, §8).
3. **What "full state" in a snapshot means.** → Currency and total limit of a program; "bulk" means many programs in one message.
4. **What to do when a snapshot disagrees with local state.** → Treasury's limit wins; reservations are untouched because treasury does not know them.
5. **Ordering / deduplication of treasury messages.** → A7.
6. **Partial reservation / release, several reservations per invoice.** → A1.
7. **FX source, timing, rounding.** → A4–A6.
8. **Meaning of "real time".** → A10.
9. **Clients and roles.** → A11.
10. **Limit below reserved.** → A9.
11. **Release of an unknown invoice.** → `404 RESERVATION_NOT_FOUND`.
12. **Stale local capacity while a treasury reduction is in flight.** → §11.3, the main documented trade-off.

---

## 4. Smallest sensible architecture

One NestJS process, one Postgres database, one Kafka topic consumed.

```
                    ┌──────────────────────────────────────────┐
  clients ──REST──▶ │  NestJS app                              │
   (JWT)  /docs     │  ┌────────┐ ┌──────────┐ ┌────────────┐  │
                    │  │ auth   │ │ programs │ │  treasury  │◀─┼── Kafka topic
                    │  │ (JWT)  │ │ reserve/ │ │  consumer  │  │   treasury.program-capacity
                    │  └────────┘ │ release/ │ │ (kafkajs)  │  │   (single updates keyed by programId,
                    │             │          │ │            │  │    bulk snapshots unkeyed)
                    │             │ avail.   │ └─────┬──────┘  │
                    │             └────┬─────┘       │         │
                    │        ┌─────────▼─────────────▼──────┐  │
                    │        │ CapacityService              │  │
                    │        │ TypeORM transactions +       │  │
                    │        │ FOR UPDATE on programs row   │  │
                    │        └───────────────┬──────────────┘  │
                    │  ┌──────┐ ┌──────┐     │                 │
                    │  │  fx  │ │money │     │                 │
                    │  └──────┘ └──────┘     │                 │
                    └────────────────────────┼─────────────────┘
                                             ▼
                                        PostgreSQL
```

Modules:

| Module | Responsibility |
|--------|----------------|
| `money` | `Money` value object: `bigint` minor units + currency; parse/format decimal strings; fixed-point FX multiplication; rounding. Pure, no I/O. |
| `fx` | `FxRateProvider` interface + `StaticFxRateProvider` (config-backed). |
| `programs` | Entities, migrations, `CapacityService` (reserve / release / availability / applyTreasuryCapacity), REST controller, DTOs. |
| `treasury` | Kafka consumer (kafkajs), payload validation, dispatch to `CapacityService`. Dev-only publisher script. |
| `auth` | JWT guard registered globally (`APP_GUARD`), `@Public()` decorator, `POST /auth/token`. |
| `health` | `GET /health` (public). |

Key choices and alternatives:

- **Persistence: TypeORM** (decided). Entities with decorators, migrations in TypeScript, `synchronize: false` always. All write paths run inside an explicit transaction (`DataSource.transaction` / `QueryRunner`) and start with a `QueryBuilder` `setLock('pessimistic_write')` on the program row. `bigint` columns use a shared `BigIntTransformer` (`to: String`, `from: BigInt`); `NUMERIC` columns are left as strings and parsed by `money`. Aggregates (`SUM`) come from `getRawOne()` as strings and are converted with `BigInt()`. `save()` with cascades is avoided on the critical paths in favour of explicit `insert` / `update`.
  **Every query inside a transaction goes through the transactional `EntityManager`** passed to the callback, never through an injected repository. A repository call inside the callback runs on a different pooled connection, outside the transaction, and the row lock silently does not apply. The concurrency test would catch this, but the rule is stated so it is not relied on to catch it.
  Isolation level is Postgres default **READ COMMITTED**; explicit row locks provide all the serialisation needed. SERIALIZABLE is not used because it would require retry logic for serialization failures without adding safety here.
  Alternatives considered: Kysely (typed SQL, cleaner for this task, less conventional), Prisma (row lock only via raw SQL, Decimal is `decimal.js`).
- **Kafka client: `kafkajs` directly**, not `@nestjs/microservices` Kafka transport, because offset semantics and error handling are the point of the exercise.
- **Consumer runs in the same process** as the API. Splitting is a one-line env flag later; not required today.
- **Swagger** via `@nestjs/swagger` at `/docs` with bearer auth, so a reviewer can authorise once and exercise every endpoint from the browser.

---

## 5. Database model

Two tables. All monetary columns are `BIGINT` minor units (cents). Currency scale comes from a small in-code table (`USD:2, EUR:2, GBP:2, JPY:0, ...`).

```sql
CREATE TABLE programs (
  id                TEXT        PRIMARY KEY,           -- treasury's program id, e.g. 'PRG-001'
  currency          CHAR(3)     NOT NULL,
  total_limit_minor BIGINT      NOT NULL CHECK (total_limit_minor >= 0),
  treasury_version  BIGINT      NOT NULL,              -- last applied per-program version (A7)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  program_id            TEXT          NOT NULL REFERENCES programs(id),
  invoice_id            TEXT          NOT NULL,
  invoice_amount_minor  BIGINT        NOT NULL CHECK (invoice_amount_minor > 0),
  invoice_currency      CHAR(3)       NOT NULL,
  fx_rate               NUMERIC(20,10) NOT NULL CHECK (fx_rate > 0), -- frozen at reservation time; 1 if same currency
  reserved_amount_minor BIGINT        NOT NULL CHECK (reserved_amount_minor > 0), -- in program currency
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  released_at           TIMESTAMPTZ   NULL,            -- NULL = active
  PRIMARY KEY (program_id, invoice_id)                 -- idempotency safety net
);
CREATE INDEX reservations_active_by_program
  ON reservations (program_id) WHERE released_at IS NULL;
```

Derived values, never stored:

- `reserved = SUM(reserved_amount_minor) WHERE program_id = $1 AND released_at IS NULL`
- `available = total_limit_minor - reserved` (may be negative, A9)
- reservation `status` = `ACTIVE` if `released_at IS NULL` else `RELEASED`

The read path (`GET /programs/:id`) fetches the limit and the sum in **one
SQL statement** (`SELECT p.*, COALESCE((SELECT SUM(...) ...), 0) AS reserved
FROM programs p WHERE p.id = $1`). Two separate queries could straddle a
committed treasury update and return a limit from one state with a sum from
another. One statement sees one snapshot, with no lock and no transaction.

What was removed and why (v1 → v2):

| Removed | Reason |
|---------|--------|
| `programs.reserved_minor` counter | Not needed for correctness; `SUM` under the same lock is exact, and no counter/rows invariant has to be maintained or tested. Cache it when measured, not before. |
| `programs.treasury_synced_at`, `updated_at` | Not required by TASK.md; not used by any rule. |
| `reservations.id UUID` | `(program_id, invoice_id)` is the natural key. |
| `reservation_status`, `reservation_source`, `release_reason` enums | `status` is derivable from `released_at`; `source` and `release_reason` existed only for treasury-imported reservations, which no longer exist. |
| `treasury_events` table | Duplicate delivery is handled by the per-program `version` check, which is sufficient because messages carry absolute state (A7). |

Kept and justified:

| Kept | Reason |
|------|--------|
| `fx_rate` | Without it the converted amount cannot be explained or audited. |
| `invoice_amount_minor`, `invoice_currency` | Needed to detect an idempotency conflict (same invoice, different amount) and to echo the client's request. |
| `treasury_version` | Idempotency and ordering of treasury messages. |

Demo data: a dedicated seed migration inserts `PRG-DEMO` (USD, limit 10,000,000.00, `treasury_version = 0`). Version 0 means "no treasury message received yet"; the first real treasury message for any program must carry `version >= 1`, which validation enforces. The seed is documented as demo data that would not be part of a production migration chain.

---

## 6. REST API

Base path `/api/v1`. Swagger UI at `/docs`. All amounts are decimal strings. All endpoints require `Authorization: Bearer <jwt>` except the two marked public.

| Method | Path | Purpose | Responses |
|--------|------|---------|-----------|
| `GET`  | `/health` | liveness (public) | 200 |
| `POST` | `/auth/token` | client credentials → JWT (public) | 200 `{accessToken, expiresIn}`; 401 |
| `GET`  | `/programs/:id` | program with availability: `{programId, currency, totalLimit, reserved, available, treasuryVersion}` | 200; 404 |
| `POST` | `/programs/:id/reservations` | reserve `{invoiceId, amount, currency}` | 201 created; **200 already exists (idempotent replay)**; 409 `IDEMPOTENCY_CONFLICT`; 409 `INSUFFICIENT_CAPACITY`; 422 `UNSUPPORTED_CURRENCY`; 404 |
| `POST` | `/programs/:id/reservations/:invoiceId/release` | release (repaid) | 200 (idempotent, also when already released); 404 |
| `GET`  | `/programs/:id/reservations?status=ACTIVE\|RELEASED` | list reservations (kept so a reviewer can inspect state without the DB) | 200; 404 |

Reservation body (returned by reserve, release, and each list item), all amounts as strings:

```json
{
  "programId": "PRG-DEMO",
  "invoiceId": "INV-1001",
  "status": "ACTIVE",
  "invoiceAmount": "1000.00",
  "invoiceCurrency": "EUR",
  "fxRate": "1.0800000000",
  "reservedAmount": "1080.00",
  "reservedCurrency": "USD",
  "createdAt": "2026-09-15T10:00:00.000Z",
  "releasedAt": null
}
```

Error body everywhere: `{ "code": "INSUFFICIENT_CAPACITY", "message": "...", "details": {...} }`.

Routing: `/health` and `/docs` at the root, business endpoints and `/auth/token` under `/api/v1`. The list endpoint is unpaginated; noted in README as a next step.

Why `POST .../release` and not `DELETE`: a release is a business event with a timestamp, not the removal of a resource; the row is kept.

---

## 7. What Kafka is responsible for in THIS assignment

Kafka is the **inbound channel from treasury only**. This service:

- **consumes** one topic, `treasury.program-capacity`;
- **does not produce** any business events (no outbox, no notifications);
- uses Kafka for exactly two things:
  1. incremental capacity updates for one program (`CAPACITY_UPDATED`);
  2. periodic bulk reconciliation of many programs (`PROGRAM_SNAPSHOT`).

API-driven reservations and releases are synchronous DB transactions; Kafka
is not in that path.

**Ordering is guaranteed by `version`, not by partitioning.** Single-program
`CAPACITY_UPDATED` messages are keyed by `programId`, so consecutive updates
for one program land on one partition in order. A bulk `PROGRAM_SNAPSHOT`
covers many programs and therefore cannot carry a per-program key; it is
sent unkeyed and may land on any partition. A snapshot and an update for the
same program can thus be consumed in either order. That is safe only because
every entry carries an absolute state plus a monotonic `version`, and the
handler applies an entry only if its version is newer (§8.3). Partitioning
by `programId` is an optimisation that reduces reordering and lock
contention for the common case; it is not a correctness mechanism.

Delivery model: **at-least-once + idempotent handler**. The offset is
committed only after the whole message has been handled (§8.4).

Consumer configuration: group id `capacity-service`, `fromBeginning: true`
(so a snapshot published before the app started is still applied, which is
what the local demo relies on), `partitionsConsumedConcurrently: 1` (default;
one instance processes messages sequentially, but nothing in the design
depends on that, so several instances are safe). The topic is created by the
Compose stack at startup; kafkajs fails to subscribe to a missing topic.

---

## 8. Kafka event schemas and handling

Envelope (JSON):

```json
{
  "eventId":    "5f0c...-uuid",         // optional, logging / tracing only
  "type":       "CAPACITY_UPDATED" | "PROGRAM_SNAPSHOT",
  "occurredAt": "2026-09-15T10:00:00Z", // optional, logging only
  "payload":    { ... }
}
```

### 8.1 `CAPACITY_UPDATED` (one program)

```json
{ "programId": "PRG-001", "version": 42, "currency": "USD", "totalLimit": "9500000.00" }
```

### 8.2 `PROGRAM_SNAPSHOT` (bulk, many programs, aggregate capacity only)

```json
{
  "programs": [
    { "programId": "PRG-001", "version": 43, "currency": "USD", "totalLimit": "10000000.00" },
    { "programId": "PRG-002", "version": 7,  "currency": "EUR", "totalLimit": "2500000.00" }
  ]
}
```

The payload contains **no invoice-level data**. TASK.md does not say treasury
knows about reservations, and inventing that would contradict CLAUDE.md.
"Full state" of a program = its currency and total limit. A snapshot only
adds or updates the programs it lists; programs it does not mention are not
touched (A14).

### 8.3 One handler for both types: `applyTreasuryCapacity(entry)`

Both message types carry the absolute state of a program, so the difference
is only in shape: one entry vs. an array of entries. Each entry runs in
**its own DB transaction**:

1. `INSERT INTO programs (id, currency, total_limit_minor, treasury_version) VALUES (...) ON CONFLICT (id) DO NOTHING`.
   For a new program this creates the row with the entry's full state and the transaction now holds its lock. For an existing program it is a no-op. **This closes the creation race:** `SELECT ... FOR UPDATE` cannot lock a row that does not exist, so two concurrent entries for a brand-new program (a snapshot and an update from different partitions, or one message on two consumers after a rebalance) would both see "missing" and both insert; the loser would hit the PK and go through an error retry for an expected situation. With `ON CONFLICT DO NOTHING` Postgres waits for the concurrent uncommitted insert, the winner creates the row, the loser sees it and continues with step 2 as for any existing program. No reservations are ever created here.
2. `SELECT ... FROM programs WHERE id = $1 FOR UPDATE` (same lock the API uses; the row is now guaranteed to exist).
3. `version <= treasury_version` → do nothing, commit. For the creator of the row this is always true (it just wrote that version). This one check rejects both duplicate deliveries and stale messages; it is correct only because the payload is absolute state.
4. `currency` differs → reject, log (A13). Commit nothing.
5. Otherwise `UPDATE programs SET total_limit_minor = $2, treasury_version = $3 WHERE id = $1`.
6. Commit.

The `reservations` table is never read or written by treasury handling.
Availability is derived at read time, so a limit change is reflected
immediately with nothing to recompute.

### 8.4 Acknowledgement: one message, one ack

A bulk snapshot is one Kafka message. The handler validates the envelope,
loops over all entries (each in its own transaction as above), and returns
only after the last entry. In kafkajs `eachMessage`, the offset is resolved
when the handler promise resolves, so there is no per-entry commit.

**Heartbeat inside the loop.** A large snapshot processed one transaction at
a time can exceed the consumer `sessionTimeout` (30 s by default). The broker
would then consider the consumer dead, rebalance, and hand the same message
to another consumer while this one is still working. The `version` check
keeps that safe, but it is an avoidable rebalance storm. The loop therefore
calls the `heartbeat()` function kafkajs passes to `eachMessage` every N
entries (N = 50, configurable).

**Error policy, stated explicitly.** Everything that can make a message
permanently unprocessable is checked *before* any DB access (§12.4,
including the BIGINT range check). Consequently any error thrown by the DB
during an entry is treated as transient and re-thrown. kafkajs then retries
the message according to `retry` (initial 300 ms, up to 5 attempts), and if
retries are exhausted the consumer crashes and `restartOnFailure` restarts
it. A crash loop on a persistent DB outage is the intended behaviour: it is
visible, and the alternative (skipping) would silently lose a limit change.

| Failure | Behaviour |
|---------|-----------|
| Transient DB error on entry *k* | Handler throws; entries `1..k-1` stay committed; offset not committed; message redelivered; on redelivery `1..k-1` are skipped by the version check, *k* onward are applied. |
| Process crash mid-payload | Same as above. |
| Partial state visible between entries | Acceptable: each entry is the absolute state of an independent program. |
| Invalid envelope | Log with topic/partition/offset, skip, ack (poison-pill protection). |
| Invalid entry inside a snapshot | Log and skip that entry; valid entries still applied. |

One transaction for the whole payload was rejected: it would hold row locks
on every program in the batch, blocking API reservations on unrelated
programs, and one bad entry would roll back all good ones.

---

## 9. FX strategy

```ts
interface FxRateProvider {
  getRate(from: Currency, to: Currency): Promise<FxRate>; // throws UnsupportedCurrencyPair
}
```

- `StaticFxRateProvider` reads rates from config: `FX_RATES='{"EUR/USD":"1.0800","USD/EUR":"0.9259"}'`. Values must be strings; config validation rejects numbers. `X/X` is always `1`. **Each direction is configured explicitly; nothing is derived.** Deriving `USD/EUR` as `1 / EUR/USD` would round the rate itself and then freeze the rounded value on reservations, so a round trip would not close. A missing direction is simply an unsupported pair.
- **The rate is never a JS `number`.** In Postgres it is `NUMERIC(20,10)`; the `pg` driver returns `NUMERIC` as a string, and a test asserts that. In code the string is parsed into a `bigint` scaled by `10^10` (fixed-point, i.e. a rational with a fixed denominator).
- Conversion is entirely in `bigint`:
  `converted_minor = round_half_up( amount_minor × rate_scaled × 10^scale_to / (10^10 × 10^scale_from) )`,
  rounding decided from the remainder of the integer division.
- The rate and the converted amount are **frozen on the reservation row** (A4). Release never calls the provider.
- Unknown pair → `422 UNSUPPORTED_CURRENCY`. Fail closed, never guess a rate.
- `parseFloat` / `Number(...)` on money or rates is forbidden by a lint rule (or a CI grep).
- `Money.parse` rejects any value whose minor-unit representation does not fit Postgres `BIGINT` (`|x| <= 2^63 - 1`), and the conversion checks the result the same way. This is a technical bound, not a business rule: without it an oversized amount passes DTO validation and fails at `INSERT`, which is a `500` for the API and, for Kafka, a DB error that the consumer treats as transient and retries forever.

Why fixed-point `bigint` and not `decimal.js`: amounts are already `bigint`;
a second numeric system for rates would put an error-prone conversion at
every boundary. One rule is easy to defend: all money and all rates are
integers with a known scale.

Why not convert at release time with a fresh rate: capacity accounting must
close exactly; FX drift between reservation and repayment is a treasury P&L
concern, not a capacity concern.

---

## 10. Authentication

- **JWT HS256**, secret from `JWT_SECRET`, expiry from `JWT_EXPIRES_IN` (default 1h).
- `JwtAuthGuard` is registered as a global `APP_GUARD`, so **every route is protected by default**; only `@Public()` opts out (`/health`, `/auth/token`). This prevents forgetting a guard on a new controller.
- `POST /auth/token` takes `{clientId, clientSecret}` and compares them with `API_CLIENT_ID` / `API_CLIENT_SECRET` from env using `crypto.timingSafeEqual` on the **SHA-256 digests** of both values. `timingSafeEqual` throws on inputs of different length, and comparing lengths first would leak the secret's length; hashing makes both inputs 32 bytes. Claims: `sub = clientId`, `iat`, `exp`.
- Swagger UI has a bearer "Authorize" button wired to the same guard.
- No users table, no roles, no refresh tokens (A11).
- **Explicit deviation from "all endpoints must be authenticated":** three routes are public. `GET /health` so Docker and orchestrators can probe without a token; `POST /auth/token` because it is the endpoint that issues tokens; `GET /docs` because it serves the API description, not data. Every endpoint that reads or writes business state is authenticated. This is stated in README, not hidden.
- Production path (documented, not built): RS256 with keys from an identity provider's JWKS endpoint; only the guard's verification options change.

---

## 11. Race conditions, idempotency and consistency

### 11.1 Concurrency inside this service

| # | Problem | Mitigation |
|---|---------|------------|
| C1 | Two concurrent reservations both see enough capacity → oversubscription. | Every write path starts with `SELECT ... FOR UPDATE` on the program row inside a transaction. Postgres serialises writers per program; `SUM(active) + amount <= limit` is evaluated after the lock is held. Verified by a test firing N parallel requests and asserting exactly `floor(limit/amount)` succeed. |
| C2 | Client retries a reservation → double reserve. | Under the lock, look up `(program_id, invoice_id)`; if present with the same amount and currency → `200` with the existing row. The composite PK is the safety net. |
| C3 | Same `invoiceId`, different amount or currency. | `409 IDEMPOTENCY_CONFLICT`. |
| C4 | Duplicate release. | Under the lock: already released → `200`, no change. |
| C5 | Reserve and release interleaving on one program. | Same lock. |

There is no counter, so there is no counter drift to guard against.

### 11.2 Kafka

| # | Problem | Mitigation |
|---|---------|------------|
| K1 | Duplicate delivery (rebalance, crash after DB commit but before offset commit). | `version <= treasury_version` under the lock → skip. |
| K2 | Out-of-order or stale messages, including a snapshot and an update for the same program arriving from different partitions in either order. | Same check under the lock. Partitioning only reduces how often this happens; `version` is what makes it correct. |
| K3 | Treasury message and an API reservation racing on one program. | Both take the same row lock; whichever commits first is simply "before". |
| K4 | Poison message blocks a partition. | Validation failures are logged and skipped, never re-thrown. |
| K5 | Consumer crashes mid-payload. | §8.4: committed entries are skipped on redelivery, the rest are applied. |

### 11.3 The stale-capacity trade-off (asynchronous treasury updates)

**The problem.** Treasury publishes `CAPACITY_UPDATED` lowering a limit from
10M to 8M. Until the consumer processes it, the API still sees 10M and can
accept a reservation treasury would have refused. The window is the consumer
lag: milliseconds normally, minutes if the consumer is down, unbounded if the
broker is unreachable.

**This is inherent** to "capacity flows in via Kafka". The only way to
eliminate the window is a synchronous call to treasury at reservation time,
which the task does not offer and which would couple every reservation to
treasury availability.

**What happens after the update lands.** The limit drops, reservations stay,
`available` becomes negative, new reservations are rejected until enough
releases arrive. Nothing already approved is cancelled (A9). The overshoot is
bounded by what was accepted during the lag window and self-corrects through
repayments. Treasury and this service never disagree about reservations,
because only this service holds them.

**Mitigations considered:**

| Option | In scope? |
|--------|-----------|
| M1. Document the window; expose `treasuryVersion` in the availability response so a client can correlate with treasury. | **Yes (MVP)** |
| M2. Monitor consumer lag and alert. | README only |
| M3. Freshness circuit breaker (reject reservations when no treasury message for too long). | **Out of scope**; README "next steps" |
| M4. Safety buffer on the limit. | README only; a business decision |
| M5. Synchronous confirmation / two-phase reservations. | No; contradicts the Kafka-only integration |

README statement: *local availability is eventually consistent with treasury;
this service is authoritative for reservations and treats treasury as
authoritative for the limit; a brief overshoot after a treasury reduction is
possible, bounded and self-correcting.*

---

## 12. Validation: three levels plus Kafka

Each level catches a different failure; none invents a business rule TASK.md does not state.

### 12.1 HTTP DTO validation (shape)

`class-validator` + global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`.

| Input | Rule |
|-------|------|
| `invoiceId` | non-empty string |
| `amount` | **string** matching `^\d+(\.\d+)?$`, not zero, minor units within BIGINT range |
| `currency` | 3 uppercase letters |
| `programId` (path) | non-empty string |
| `clientId`, `clientSecret` | non-empty strings |
| `status` (query) | `ACTIVE` \| `RELEASED` |
| any body | unknown fields rejected |

### 12.2 Business-rule validation (state, inside the transaction, under the lock)

| Rule | Result |
|------|--------|
| program exists | `404 PROGRAM_NOT_FOUND` |
| currency has a known scale and `amount` does not exceed it (`"10.005"` USD) | `422 UNSUPPORTED_CURRENCY` / `400 INVALID_AMOUNT_SCALE` |
| FX pair available (or same currency) | `422 UNSUPPORTED_CURRENCY` |
| converted amount > 0 after rounding | `422 AMOUNT_TOO_SMALL` |
| same `invoiceId`, same amount and currency | `200` existing (idempotent) |
| same `invoiceId`, different amount or currency | `409 IDEMPOTENCY_CONFLICT` |
| `SUM(active) + converted <= totalLimit` | else `409 INSUFFICIENT_CAPACITY` |
| release: reservation exists | else `404 RESERVATION_NOT_FOUND` |
| release: already released | `200`, no change |
| treasury entry: `version` newer | else skip |
| treasury entry: `currency` unchanged for an existing program | else reject + log |

### 12.3 Database constraints (last line of defence)

| Constraint | Protects against |
|------------|------------------|
| `reservations PK (program_id, invoice_id)` | double reservation if anything bypasses the lock path |
| `program_id REFERENCES programs(id)` | orphan reservations |
| `CHECK (... > 0)` on money columns and `fx_rate` | corrupted or zero rows |
| `CHECK (total_limit_minor >= 0)` | negative limit from a bad message |
| `NOT NULL` on money / currency / version columns | partial rows |

No DB trigger for `SUM(active) <= limit`: the invariant spans rows and is
guaranteed by the lock + service check; a trigger would be a hidden fourth
layer that is hard to explain and test.

### 12.4 Kafka payload validation (before any DB access)

Same `class-validator` on message classes via `plainToInstance`, one vocabulary for HTTP and Kafka.

| Field | Rule |
|-------|------|
| `eventId` | optional string, logged if present |
| `type` | `CAPACITY_UPDATED` \| `PROGRAM_SNAPSHOT` |
| `occurredAt` | optional string, logged if present, format not enforced (unused by any rule; enforcing a format would reject valid messages from an unknown contract) |
| entry `programId` | non-empty string |
| entry `version` | JSON number **or** digit string; if a number, `Number.isSafeInteger` must hold (JSON numbers are doubles and lose integer precision above 2^53, so an epoch-nanosecond style version would compare wrongly and silently skip or accept the wrong message); parsed to `bigint` before any comparison; `>= 1` (0 is reserved for "never received from treasury", used by the seed) |
| entry `currency` | 3 uppercase letters, known scale |
| entry `totalLimit` | decimal string, `>= 0`, scale within the currency's minor unit, minor units within BIGINT range |
| snapshot `programs` | array of entries; an empty array is a valid message and a no-op, not an error |

### 12.5 Explicitly not validated

No business-defined maximum amount; only the technical PostgreSQL BIGINT
bound applies. No currency whitelist beyond "scale is known", no identifier
formats, no reservation count limits, no date rules, no `totalLimit > 0`
(a frozen program with limit 0 is legitimate).

---

## 13. Test strategy

| Layer | Tool | Covered |
|-------|------|---------|
| Unit | Jest, no I/O | `Money` parse/format/rounding (USD, JPY), fixed-point FX conversion incl. inverse pairs and unsupported pair, `StaticFxRateProvider` config parsing rejects numbers, token service, DTO validation. |
| Integration (real Postgres via `docker-compose.test.yml`) | Jest + Nest testing module | reserve → availability → release round trip; idempotent replay (200) and conflict (409); insufficient capacity; **concurrency**: 25 parallel reservations of 1,000 against a 10,000 limit → exactly 10 succeed, `reserved == 10,000`; `pg` returns `NUMERIC` as string and `BIGINT` round-trips through the transformer; treasury handler called directly with message objects: duplicate version, stale version, new program created, limit updated, currency change rejected, bulk payload with one invalid entry, bulk payload with a failing entry leaves earlier entries committed; two concurrent entries for the same new program (handler invoked in parallel) create exactly one row with the higher version; `version` above 2^53 as a number is rejected, as a digit string is accepted; limit below reserved → negative available and rejected reservation. |
| E2E HTTP | supertest | 401 without token; 400 on unknown fields and numeric amount; happy path through real controllers. |
| Kafka wiring | dev script `npm run treasury:publish -- snapshot`, manual smoke | Broker connectivity and JSON envelope. Not in Jest: a broker in tests is slow and flaky, and the handler logic is covered directly. |

---

## 14. What would be overengineering here

Deliberately **not** doing:

- Event sourcing / CQRS / read models; transactional outbox (nothing is produced).
- Redis or distributed locks: Postgres row locks are sufficient and transactional.
- Splitting API and consumer into two services.
- Exactly-once Kafka transactions; schema registry / Avro; dead-letter topic infrastructure (log + skip is enough for one producer).
- A `treasury_events` audit table while `version` is available.
- A materialised `reserved` counter before it is measured to be needed.
- RBAC, multi-tenancy, refresh tokens, user management.
- WebSocket / SSE push; external FX API; partial reservations.
- Freshness circuit breaker (M3) and safety buffers (M4).
- Kubernetes / Helm; generic repository layers.

---

## 15. Implementation phases (each = one reviewable commit, none starts before the previous is reviewed)

| Phase | Deliverable | Explain-in-chat focus |
|-------|-------------|-----------------------|
| 0 | This plan, `.gitignore`, `git init` | — |
| 1 | NestJS skeleton, env config validation, `docker-compose.yml` (postgres and kafka KRaft single node with healthchecks, a one-shot `kafka-init` service that creates `treasury.program-capacity`, app with `depends_on: condition: service_healthy`), TypeORM data source, migrations run as a separate entrypoint step **before** the app starts (not from application code, so two instances cannot race on migrations), `/health`, Swagger at `/docs`, lint + Jest wiring, README skeleton | why config is validated at boot; why `synchronize` is off; why migrations are a separate step |
| 2 | `money` + `fx` modules with unit tests | bigint minor units; fixed-point rate; rounding; why the rate is frozen |
| 3 | `programs` domain: migrations (two tables + demo seed), entities with `BigIntTransformer`, `CapacityService.reserve / release / getProgram / listReservations`, integration tests incl. concurrency | `FOR UPDATE`; `SUM` under the lock; idempotency under the lock |
| 4 | REST controllers, DTO validation, error filter with codes, `auth` module (global guard, `@Public`, token endpoint), Swagger annotations, e2e tests | secure-by-default guard; three validation levels |
| 5 | `treasury` consumer: envelope + entry validation, `applyTreasuryCapacity`, bulk loop with one ack, handler tests, publisher script | absolute state + version = idempotency; one ack per message; poison-pill policy |
| 6 | README: run instructions, auth walk-through, Swagger pointer, curl examples, Kafka message examples, consistency model (§11.3), assumptions table, "what I would do next" | — |

Working rules for every phase:

- Non-trivial logic gets a short comment block: **Why / Failure mode it prevents / Assumption**. The same points are summarised in chat so the code can be defended in an interview.
- Commits are manual.

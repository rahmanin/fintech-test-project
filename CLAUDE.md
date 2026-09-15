# Project

Take-home assignment for a Mid-Level Node.js Engineer role.

Read TASK.md first. TASK.md is the source of truth. Do not silently invent
business requirements that are not present there.

# Preferred stack

- Node.js
- TypeScript
- NestJS
- PostgreSQL
- Docker / Docker Compose
- Kafka
- Jest
- REST API
- JWT authentication

# Engineering goals

Treat this as production-quality take-home code, but avoid unnecessary
overengineering.

Prioritize:
- correctness
- readability
- transactional consistency
- idempotency
- concurrency safety
- clear error handling
- testability
- simple local startup
- useful README documentation

Do not add microservices, Redis, Kubernetes, CQRS frameworks, event sourcing,
or other infrastructure unless there is a concrete requirement for it.

# Important rules

- Monetary values must not use floating-point JavaScript arithmetic.
- Reservations must not allow local program capacity to be oversubscribed
  under concurrent requests.
- Reservation and release operations must be idempotent where appropriate.
- Kafka messages must be handled safely with duplicate delivery in mind.
- Treasury data arrives asynchronously, so document consistency limitations
  and assumptions explicitly.
- FX conversion is underspecified in TASK.md. Do not silently choose an
  external FX API. Propose a simple abstraction suitable for this exercise.
- All HTTP business endpoints must be authenticated.
- The application must be runnable locally.
- Include integration/unit tests for important business cases.

# Working style

Before making substantial architectural decisions:
1. explain the problem,
2. present alternatives,
3. recommend the simplest defensible option.

Do not implement the whole assignment in one step.
Work in small reviewable phases.

Non-trivial business and consistency logic should be accompanied by concise
documentation explaining:
- why the approach was chosen;
- which failure modes it addresses;
- relevant assumptions and trade-offs.
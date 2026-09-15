#!/bin/sh
# Apply migrations as an explicit step, then start the server.
# If migrations fail the container exits non-zero and the app never
# serves requests against a half-migrated schema.
set -e
node dist/database/migrate.js
exec node dist/main.js

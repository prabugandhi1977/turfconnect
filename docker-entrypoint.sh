#!/bin/sh
# Container start: make the data volume writable (hosted disks are often mounted root-owned), drop to the
# unprivileged "node" user, load demo data if asked (only into an empty database), then start the server.
set -e
DATA_DIR="${TURF_DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$0" "$@"
fi
if [ "$TURF_SEED_DEMO" = "true" ]; then node server/seed.js; fi
exec node server/server.js

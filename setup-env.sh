#!/bin/sh
# Generate env.js from .env.local (for local dev) or environment variables (for CI)

ENV_FILE=".env.local"

if [ -f "$ENV_FILE" ]; then
  . "./$ENV_FILE"
fi

: "${PARTYKIT_HOST:?PARTYKIT_HOST is not set. Create .env.local from .env.example}"

cat > env.js <<EOF
export const PARTYKIT_HOST = '${PARTYKIT_HOST}';
EOF

echo "env.js generated (host: ${PARTYKIT_HOST})"

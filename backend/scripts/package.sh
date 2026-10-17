#!/usr/bin/env bash
# Builds the deployable backend tarball: compiled CSS/JS, a build.json that says which commit
# it is, no node_modules (the egg runs `bun install`), no tests, no databases, no .env.
# Usage: scripts/package.sh <output-dir>      (run from backend/; needs bun and git)
set -euo pipefail
out="${1:?usage: package.sh <output-dir>}"
cd "$(dirname "$0")/.."
mkdir -p "$out"
out="$(cd "$out" && pwd)"

bun install --frozen-lockfile
bun run build

commit="$(git rev-parse HEAD)"
dirty=false
[ -n "$(git status --porcelain -- .)" ] && dirty=true
printf '{"commit":"%s","dirty":%s,"builtAt":"%s"}\n' "$commit" "$dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build.json

tar --exclude=node_modules --exclude='*.sqlite' --exclude='*.sqlite-*' --exclude='.env*' --exclude=test \
  -czf "$out/backend.tar.gz" .
rm build.json
(cd "$out" && sha256sum backend.tar.gz > backend.tar.gz.sha256)
echo "packaged $commit (dirty=$dirty) -> $out/backend.tar.gz"

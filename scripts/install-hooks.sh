#!/usr/bin/env bash
# Install local git hooks. Run once after cloning: ./scripts/install-hooks.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="$ROOT_DIR/.git/hooks"

if [ ! -d "$ROOT_DIR/.git" ]; then
  echo "error: not a git repository." >&2
  exit 1
fi

mkdir -p "$HOOKS_DIR"

cat > "$HOOKS_DIR/pre-commit" <<'HOOK'
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/scripts/pre-commit.sh"
HOOK
chmod +x "$HOOKS_DIR/pre-commit"

echo "installed: .git/hooks/pre-commit -> scripts/pre-commit.sh"

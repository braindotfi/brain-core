#!/usr/bin/env bash
# Brain pre-commit hook — §11.3: prohibit secrets in code.
# Installed by scripts/install-hooks.sh. Fails the commit if a likely secret is found.
# Intentionally conservative: a real gitleaks / trufflehog pass runs in CI.
set -euo pipefail

# Collect staged content (additions only) to scan.
staged="$(git diff --cached --no-color --no-ext-diff --unified=0 --diff-filter=ACM \
  -- ':!*.md' ':!*.lock' ':!pnpm-lock.yaml' ':!Brain_API_Specification.yaml' \
  | grep -E '^\+' | grep -Ev '^\+\+\+ ' || true)"

if [ -z "$staged" ]; then
  exit 0
fi

# Patterns: AWS keys, GitHub tokens, PEM blocks, Slack tokens, private keys,
# bearer literals, Anthropic / OpenAI keys, Azure connection strings.
patterns=(
  'AKIA[0-9A-Z]{16}'
  'ASIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_\-]{35}'
  'ghp_[0-9A-Za-z]{36,}'
  'gho_[0-9A-Za-z]{36,}'
  'github_pat_[0-9A-Za-z_]{60,}'
  'xox[baprs]-[0-9A-Za-z-]{10,}'
  'sk-ant-[0-9A-Za-z_\-]{20,}'
  'sk-[A-Za-z0-9]{40,}'
  '-----BEGIN (RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----'
  'DefaultEndpointsProtocol=https;AccountName='
  'eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+'  # bare JWT
)

violations=0
for pat in "${patterns[@]}"; do
  if echo "$staged" | grep -E "$pat" >/dev/null; then
    echo "error: pre-commit secret scan — pattern matched: $pat" >&2
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "Brain §11.3 prohibits secrets in code, config, or commits." >&2
  echo "If this is a false positive, redact or mask the value and retry." >&2
  echo "Genuine secrets: rotate immediately and file a security incident." >&2
  exit 1
fi

exit 0

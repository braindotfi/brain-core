#!/usr/bin/env bash

set -euo pipefail

readonly BLOCKING_PATTERN='(pg_dump|pg_basebackup|backup|restic|borg|azcopy|mc[[:space:]]+mirror|anchor|verifier)'
# This Debian timer backs up OS package metadata only. It does not read or
# write Brain application data or PostgreSQL data.
readonly ALLOWED_SYSTEMD_TIMER_UNIT='dpkg-db-backup.timer'

blocking_lines=()

while IFS= read -r line; do
  if ! grep -Eiq "$BLOCKING_PATTERN" <<< "$line"; then
    continue
  fi

  timer_unit=''
  for field in $line; do
    if [[ "$field" == *.timer ]]; then
      timer_unit="$field"
      break
    fi
  done

  if [[ "$timer_unit" == "$ALLOWED_SYSTEMD_TIMER_UNIT" ]]; then
    line_without_allowed_unit="${line//$ALLOWED_SYSTEMD_TIMER_UNIT/}"
    line_without_allowed_unit="${line_without_allowed_unit//dpkg-db-backup.service/}"
    if ! grep -Eiq "$BLOCKING_PATTERN" <<< "$line_without_allowed_unit"; then
      continue
    fi
  fi

  blocking_lines+=("$line")
done

if (( ${#blocking_lines[@]} > 0 )); then
  echo "overlapping host schedule found" >&2
  printf '%s\n' "${blocking_lines[@]}" >&2
  exit 1
fi

echo "no overlapping host schedule found"

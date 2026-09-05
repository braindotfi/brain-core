import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(process.cwd(), "scripts/ops/check-commercial-demo-retirement-host-overlap.sh");

function checkSchedules(input) {
  return spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    input,
  });
}

test("allows only the Debian package metadata backup timer", () => {
  const result = checkSchedules(
    "Sat 2026-09-05 00:00:00 UTC 10h left dpkg-db-backup.timer dpkg-db-backup.service\n",
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /no overlapping host schedule found/);
  assert.equal(result.stderr, "");
});

test("fails closed for PostgreSQL and Brain backup timers", () => {
  for (const timer of ["postgresql-backup.timer", "brain-backup.timer"]) {
    const result = checkSchedules(
      `Sat 2026-09-05 00:00:00 UTC 10h left ${timer} ${timer.replace(".timer", ".service")}\n`,
    );

    assert.equal(result.status, 1, `${timer} must fail closed`);
    assert.match(result.stderr, /overlapping host schedule found/);
    assert.match(result.stderr, new RegExp(timer.replaceAll(".", "\\.")));
  }
});

test("does not allow a near match or hide another blocking operation", () => {
  const nearMatch = checkSchedules(
    "Sat 2026-09-05 00:00:00 UTC 10h left local-dpkg-db-backup.timer local.service\n",
  );
  assert.equal(nearMatch.status, 1);

  const mixedLine = checkSchedules(
    "Sat 2026-09-05 00:00:00 UTC dpkg-db-backup.timer dpkg-db-backup.service pg_basebackup\n",
  );
  assert.equal(mixedLine.status, 1);
  assert.match(mixedLine.stderr, /pg_basebackup/);
});

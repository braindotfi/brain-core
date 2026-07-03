import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const repoRoot = new URL("../../", import.meta.url);

test("check-invariants passes", () => {
  execFileSync(process.execPath, ["scripts/check-invariants.mjs"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
});

test("check-invariants fails when self-approval moves after second approval", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-invariants-"));
  try {
    for (const file of [
      "services/execution/src/payment-intents/PaymentIntentService.ts",
      "services/execution/src/members/ActorResolver.ts",
      "services/execution/src/members/authorizeApproval.ts",
      "services/execution/src/members/authorizeApproval.test.ts",
      "services/api/src/onboarding/provision.ts",
      "services/api/src/demo/brainsaas-seed.ts",
      "services/execution/migrations/0024_bootstrap_missing_members.sql",
    ]) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(new URL(file, repoRoot), target);
    }

    const gatePath = join(root, "services/execution/src/members/authorizeApproval.ts");
    const moved = readFileSync(gatePath, "utf8")
      .replaceAll('reject("self_approval_blocked"', 'reject("moved_self_approval_blocked"')
      .replace(
        "  const requiresAdditionalApproval =",
        '  if (false) return reject("self_approval_blocked", {});\n\n  const requiresAdditionalApproval =',
      );
    writeFileSync(gatePath, moved);

    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/check-invariants.mjs"], {
          cwd: repoRoot,
          env: { ...process.env, BRAIN_INVARIANT_ROOT: root },
          stdio: "pipe",
        }),
      /Command failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("check-invariants fails when provisioning stops creating bootstrap member", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-invariants-"));
  try {
    for (const file of [
      "services/execution/src/payment-intents/PaymentIntentService.ts",
      "services/execution/src/members/ActorResolver.ts",
      "services/execution/src/members/authorizeApproval.ts",
      "services/execution/src/members/authorizeApproval.test.ts",
      "services/api/src/onboarding/provision.ts",
      "services/api/src/demo/brainsaas-seed.ts",
      "services/execution/migrations/0024_bootstrap_missing_members.sql",
    ]) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(new URL(file, repoRoot), target);
    }

    const provisionPath = join(root, "services/api/src/onboarding/provision.ts");
    const withoutBootstrap = readFileSync(provisionPath, "utf8").replace(
      "      await insertBootstrapAdminMember(c, {\n        tenantId,\n        memberId: userId,\n        email: input.email,\n        displayName: input.email,\n      });\n",
      "",
    );
    writeFileSync(provisionPath, withoutBootstrap);

    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/check-invariants.mjs"], {
          cwd: repoRoot,
          env: { ...process.env, BRAIN_INVARIANT_ROOT: root },
          stdio: "pipe",
        }),
      /Command failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

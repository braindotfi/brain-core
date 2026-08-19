const tenantId = process.env.BRAIN_TENANT_ID;
const bootstrapExternalRef = process.env.NORTHSTAR_BOOTSTRAP_EXTERNAL_REF;
const platformSecret = process.env.BRAIN_PLATFORM_SERVICE_SECRET;

if (!tenantId || !bootstrapExternalRef || !platformSecret) {
  throw new Error("Northstar presentation probe is missing required runtime inputs");
}

const session = await request("/sessions", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-platform-service-auth": platformSecret,
  },
  body: JSON.stringify({ external_ref: bootstrapExternalRef, scopes: ["wiki:read"] }),
});

if (
  typeof session.token !== "string" ||
  session.member?.tenantId !== tenantId ||
  session.member?.status !== "active"
) {
  throw new Error("Northstar presentation probe did not recover the expected tenant session");
}

const checks = [
  {
    id: "transaction_names",
    question: "Show my last 10 transactions",
    validate(answer) {
      return !/\bcp_[a-z0-9_]+\b/i.test(answer) && /Northwind Cloud|Cascade Compute/i.test(answer);
    },
  },
  {
    id: "collections_names",
    question: "Why is Collections requesting review?",
    validate(answer) {
      return (
        answer.includes("Helio Manufacturing") &&
        answer.includes("Apex Health") &&
        !/\bcp_[a-z0-9_]+\b/i.test(answer)
      );
    },
  },
  {
    id: "recommendation_copy",
    question: "What are the two pending recommendations?",
    validate(answer) {
      return !/\bno_match\b/i.test(answer) && !/\bcp_[a-z0-9_]+\b/i.test(answer);
    },
  },
];

for (const check of checks) {
  const result = await request("/wiki/question", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ question: check.question }),
  });
  const answer = typeof result.answer === "string" ? result.answer : "";
  const passed = result.answered === true && check.validate(answer);
  process.stdout.write(
    `${JSON.stringify({
      event: "northstar_presentation_probe",
      check: check.id,
      passed,
      answered: result.answered === true,
      answer,
    })}\n`,
  );
  if (!passed) throw new Error(`Northstar presentation probe failed: ${check.id}`);
}

process.stdout.write("northstar_presentation_probe_completed\n");

async function request(path, init) {
  const response = await fetch(`http://127.0.0.1:3000/v1${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Northstar presentation probe received HTTP ${response.status} for ${path}`);
  }
  return body;
}

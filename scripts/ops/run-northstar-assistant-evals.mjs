import { readFile } from "node:fs/promises";

const TENANT_ID = "tnt_01M08J9B75QH08MCVA884N57VB";
const EVAL_PATH = process.env.NORTHSTAR_EVAL_PATH;
const bootstrapExternalRef = process.env.NORTHSTAR_BOOTSTRAP_EXTERNAL_REF;
const platformSecret = process.env.BRAIN_PLATFORM_SERVICE_SECRET;

if (!EVAL_PATH || !bootstrapExternalRef || !platformSecret) {
  throw new Error("Northstar Assistant evaluation is missing its fixed runtime inputs");
}

const markdown = await readFile(EVAL_PATH, "utf8");
const questions = parseQuestions(markdown);
if (questions.length !== 34) {
  throw new Error(
    `Northstar Assistant evaluation expected 34 questions, found ${questions.length}`,
  );
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
  session.member?.tenantId !== TENANT_ID ||
  session.member?.status !== "active"
) {
  throw new Error("Northstar Assistant evaluation did not recover an active tenant member session");
}

for (const question of questions) {
  const result = await request("/wiki/question", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ question: question.text }),
  });

  process.stdout.write(
    `${JSON.stringify({
      event: "northstar_assistant_eval",
      ...question,
      answered: result.answered === true,
      answer: result.answer,
      evidence: result.evidence,
      model: result.model,
      usage: result.usage,
    })}\n`,
  );
}

process.stdout.write("northstar_assistant_evals_completed\n");

async function request(path, init) {
  const response = await fetch(`http://127.0.0.1:3000/v1${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Northstar Assistant evaluation received HTTP ${response.status} for ${path}`);
  }
  return body;
}

function parseQuestions(source) {
  let section = "golden";
  const questions = [];

  for (const line of source.split("\n")) {
    if (line === "## Additional Evaluation Questions") {
      section = "additional";
      continue;
    }
    if (line === "## Safety Cases") {
      section = "safety";
      continue;
    }
    const match = /^(\d+)\. (.+?)(?: Expected: (.+))?$/.exec(line);
    if (match === null) continue;
    questions.push({
      number: Number(match[1]),
      section,
      text: match[2],
      expected: match[3] ?? null,
    });
  }

  return questions;
}

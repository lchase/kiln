// Test double for a non-interactive coding-agent CLI. Prints a Claude JSON envelope and exits.
const prompt = process.argv.at(-1) ?? "";

if (!prompt.includes("PLACEHOLDER EXAMPLE") || !prompt.includes('"repo": "frontend"')) {
  console.error("prompt is missing ownership maps");
  process.exit(1);
}
if (!prompt.includes("Local checkouts") || !prompt.includes("examples/checkouts/frontend")) {
  console.error("prompt is missing local checkout paths");
  process.exit(1);
}

const wantsPlan = prompt.includes("Agent plan please");

if (prompt.includes("KILN_STEP: assess")) {
  const readiness = wantsPlan
    ? { ready: true, missing: [], questions: [] }
    : {
        ready: false,
        missing: ["scope"],
        questions: ["Which repo does this example change?"],
      };
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ignored",
      structured_output: readiness,
    }),
  );
  process.exit(0);
}

if (prompt.includes("KILN_STEP: decompose")) {
  if (!prompt.includes("inspect the actual code paths") || !prompt.includes("Cite file paths")) {
    console.error("decompose prompt does not tell the planner to inspect code and cite paths");
    process.exit(1);
  }
  if (!wantsPlan) {
    console.error("decompose was called for a requirement that should only return questions");
    process.exit(1);
  }
  const id = prompt.match(/"id": "([^"]+)"/)?.[1] ?? "EX-AGENT";
  const plan = {
    requirementId: id,
    contracts: [],
    tasks: [
      {
        id: `${id}-frontend`,
        repo: "frontend",
        title: "Show each habit once",
        description: "Fix the frontend day-boundary grouping so yesterday is not listed twice.",
        workflow: "bug",
        dependsOn: [],
        acceptance: ["The habit list shows each habit once"],
      },
    ],
  };
  process.stdout.write(
    JSON.stringify({
      type: "result",
      result: "ignored",
      structured_output: plan,
    }),
  );
  process.exit(0);
}

console.error("prompt missing KILN_STEP");
process.exit(1);

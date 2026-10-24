// Test double for a non-interactive coding-agent CLI. Prints JSON and exits.
const prompt = process.argv.at(-1) ?? "";

if (!prompt.includes("PLACEHOLDER EXAMPLE") || !prompt.includes('"repo": "frontend"')) {
  console.error("prompt is missing ownership maps");
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
  if (!wantsPlan) {
    console.error("decompose was called for a requirement that should only return questions");
    process.exit(1);
  }
  const id = prompt.match(/"id": "([^"]+)"/)?.[1] ?? "EX-AGENT";
  const plan = {
    requirementId: id,
    acceptance: ["The habit list shows each habit once"],
    contracts: [],
    tasks: [
      {
        id: `${id}-frontend`,
        repo: "frontend",
        workflow: "bug",
        dependsOn: [],
        contractRefs: [],
        acceptance: ["The habit list shows each habit once"],
      },
    ],
  };
  const line = (value) => JSON.stringify(value);
  process.stdout.write(
    [
      line({ type: "thread.started", thread_id: "example" }),
      line({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: JSON.stringify(plan) },
      }),
      line({ type: "turn.completed" }),
    ].join("\n"),
  );
  process.exit(0);
}

console.error("prompt missing KILN_STEP");
process.exit(1);

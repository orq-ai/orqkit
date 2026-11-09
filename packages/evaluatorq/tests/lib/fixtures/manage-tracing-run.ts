import { evaluatorq } from "../../../src/lib/evaluatorq.js";
import { getTracer, shutdownTracing } from "../../../src/lib/tracing/setup.js";

await evaluatorq("manage-tracing", {
  data: [{ inputs: {} }],
  jobs: [async () => ({ name: "job", output: "ok" })],
  print: false,
  sendResults: false,
  manageTracing: process.argv[2] === "false" ? false : undefined,
});

console.log(getTracer() ? "tracing=running" : "tracing=stopped");
await shutdownTracing();

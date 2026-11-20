Bun.plugin({
  name: "fake-orq-sdk",
  setup(build) {
    build.module("@orq-ai/node", () => ({
      loader: "object",
      exports: {
        Orq: class {
          datasets = {
            listDatapoints: async () => ({
              data: [{ _id: "dp", inputs: {} }],
              hasMore: false,
            }),
          };
        },
      },
    }));
  },
});

const { evaluatorq } = await import("../../../src/lib/evaluatorq.js");

const results = await evaluatorq("dataset-job-error", {
  data: { datasetId: "dataset" },
  jobs: [async () => ({ name: "job", output: "partial", error: "run failed" })],
  print: false,
  sendResults: false,
});

const jobResult = results[0]?.jobResults?.[0];
console.log(
  JSON.stringify({
    output: jobResult?.output,
    error: jobResult?.error?.message,
  }),
);

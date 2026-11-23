const mode = process.argv[2];
const serverURLs: string[] = [];

Bun.plugin({
  name: "fake-orq-sdk",
  setup(build) {
    build.module("@orq-ai/node", () => {
      if (mode === "inline-without-sdk") {
        throw new Error("Cannot find module '@orq-ai/node'");
      }
      return {
        loader: "object",
        exports: {
          Orq: class {
            datasets = {
              listDatapoints: async () => ({
                data: [{ _id: "dp", inputs: {} }],
                hasMore: false,
              }),
            };
            deployments = { invoke: async () => ({ choices: [] }) };
            constructor(options: { serverURL: string }) {
              serverURLs.push(options.serverURL);
            }
          },
        },
      };
    });
  },
});

const { evaluatorq } = await import("../../../src/lib/evaluatorq.js");
const { deployment } = await import("../../../src/lib/deployment-helper.js");

const job = async () => ({ name: "job", output: "done" });
const options = { jobs: [job], print: false, sendResults: false };

let rows = 0;
if (mode === "deployment") {
  await deployment("key");
} else if (mode === "dataset") {
  const results = await evaluatorq("host", {
    ...options,
    data: { datasetId: "dataset" },
  });
  rows = results.length;
} else {
  const results = await evaluatorq("inline", {
    ...options,
    data: [{ inputs: {} }],
  });
  rows = results.length;
}

console.log(JSON.stringify({ rows, serverURLs }));

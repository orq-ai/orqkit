import { evaluatorq } from "@orq/evaluatorq";
import { Orq } from "@orq-ai/node";

const orqClient = new Orq({
  apiKey: process.env.ORQ_API_KEY,
  serverURL: "https://api.staging.orq.ai",
});

orqClient.evals.contains({
  output: "output 1",
  functionParams: {
    value: "value 1",
  },
});

const _result = await evaluatorq("evaluator name", {
  data: {
    datasetId: "123",
  },
  jobs: [
    async (data) => {
      console.dir(data);

      return {
        output: "output 1",
        name: "job 1",
      };
    },
  ],
});

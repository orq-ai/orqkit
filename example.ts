import { Evaluatorq } from './packages/core/src/index.js';
import { CosineSimilarity, ExactMatch, LevenshteinDistance } from './packages/evaluators/src/index.js';

// Example usage
async function runExample() {
  const result = await Evaluatorq('Experiment007', {
    data: async () => {
      return [
        { input: 'Hello, how are you?', output: "I'm good, thank you!" },
        { input: 'What is 2+2?', output: '4' },
        { input: 'Tell me a joke', output: 'Why did the chicken cross the road? To get to the other side!' },
      ];
    },
    tasks: [
      ({ input, output }) => {
        // Simple concatenation task
        return input + ' ' + output;
      },
      ({ input, output }) => {
        // Length comparison task
        return {
          inputLength: input.length,
          outputLength: output.length,
          ratio: input.length / output.length,
        };
      },
    ],
    evaluators: [CosineSimilarity, ExactMatch, LevenshteinDistance],
  });

  console.log('\nEvaluation completed!');
  return result;
}

// Run the example
runExample().catch(console.error);
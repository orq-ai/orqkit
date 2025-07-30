// Direct test of the evaluation pattern
import { Evaluatorq } from './packages/core/src/index.js';
import { CosineSimilarity } from './packages/evaluators/src/index.js';

console.log('Running test evaluation...');

await Evaluatorq('Test Eval File Pattern', {
  data: async () => [
    { input: 'Hello', output: 'Hi there' },
  ],
  tasks: [],
  evaluators: [CosineSimilarity],
});

console.log('Test completed!');
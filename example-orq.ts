#!/usr/bin/env bun

// Test orq.ai integration
// Run with: ORQ_API_KEY=your-key bun run example-orq.ts

import { Evaluatorq } from './packages/core/src/index.js';
import { CosineSimilarity, ExactMatch } from './packages/evaluators/src/index.js';

async function runOrqExample() {
  console.log('Testing orq.ai integration...');
  console.log('API Key present:', !!process.env.ORQ_API_KEY);
  
  const result = await Evaluatorq('orq.ai Integration Test', {
    data: async () => [
      { 
        input: 'What is the capital of France?', 
        output: 'The capital of France is Paris.' 
      },
      { 
        input: 'What is 2 + 2?', 
        output: 'Two plus two equals four.' 
      },
    ],
    tasks: [
      ({ input, output }) => ({
        inputLength: input.length,
        outputLength: output.length,
        timestamp: new Date().toISOString(),
      }),
    ],
    evaluators: [
      CosineSimilarity,
      ExactMatch,
    ],
  });

  console.log('\nTest completed!');
  
  if (process.env.ORQ_API_KEY) {
    console.log('Check the orq.ai URL above to view results in the platform.');
  } else {
    console.log('To test orq.ai integration, run with: ORQ_API_KEY=your-key bun run example-orq.ts');
  }
  
  return result;
}

// Run the example
runOrqExample().catch(console.error);
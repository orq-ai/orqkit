import { Evaluatorq } from '@evaluatorq/core';
import { CosineSimilarity, LevenshteinDistance } from '@evaluatorq/evaluators';

// Compare outputs from different models
const modelAResponses = {
  'What is TypeScript?': 'TypeScript is a statically typed superset of JavaScript developed by Microsoft.',
  'Explain async/await': 'Async/await is a syntax for handling asynchronous operations in JavaScript.',
  'What is React?': 'React is a JavaScript library for building user interfaces, created by Facebook.',
};

const modelBResponses = {
  'What is TypeScript?': 'TypeScript extends JavaScript with static types, created by Microsoft for better tooling.',
  'Explain async/await': 'Async/await provides cleaner syntax for promises in JavaScript programming.',
  'What is React?': 'React is a UI library made by Meta (Facebook) for creating component-based interfaces.',
};

await Evaluatorq('Model Output Comparison', {
  data: async () => {
    return Object.keys(modelAResponses).map(question => ({
      input: modelAResponses[question],  // Model A as baseline
      output: modelBResponses[question], // Model B to compare
    }));
  },
  
  tasks: [
    ({ input, output }) => ({
      lengthDifference: Math.abs(input.length - output.length),
      modelALength: input.length,
      modelBLength: output.length,
      commonWords: findCommonWords(input, output),
    }),
  ],
  
  evaluators: [
    CosineSimilarity,
    LevenshteinDistance,
  ],
});

function findCommonWords(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/));
  const words2 = new Set(text2.toLowerCase().split(/\s+/));
  let common = 0;
  for (const word of words1) {
    if (words2.has(word)) common++;
  }
  return common;
}
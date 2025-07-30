import { Evaluatorq } from './packages/core/src/index.js';
import { CosineSimilarity, ExactMatch, LevenshteinDistance } from './packages/evaluators/src/index.js';

// Example comparing different model outputs
async function runComparisonExample() {
  // Simulating comparing two different model outputs
  const modelAOutputs = [
    'The capital of France is Paris.',
    'Two plus two equals four.',
    'TypeScript is a programming language developed by Microsoft that adds static typing to JavaScript.',
  ];
  
  const modelBOutputs = [
    'Paris is the capital city of France.',
    '4',
    'TypeScript is basically JavaScript with types. It was created by Microsoft.',
  ];
  
  const result = await Evaluatorq('Model Output Comparison', {
    data: async () => {
      return modelAOutputs.map((outputA, index) => ({
        input: outputA, // Using model A output as "expected"
        output: modelBOutputs[index]!, // Model B output as "actual"
      }));
    },
    tasks: [
      // Task: Analyze the differences
      ({ input, output }) => {
        return {
          expectedLength: input.length,
          actualLength: output.length,
          lengthDifference: Math.abs(input.length - output.length),
        };
      },
    ],
    evaluators: [
      CosineSimilarity,
      ExactMatch,
      LevenshteinDistance,
    ],
  });

  console.log('\nModel Comparison completed!');
  console.log('\n📊 Interpretation:');
  console.log('• High Cosine Similarity (>0.8) = Similar meaning');
  console.log('• ExactMatch = 0 means outputs are different');
  console.log('• Levenshtein Distance shows character-level similarity');
  
  return result;
}

// Run the example
runComparisonExample().catch(console.error);
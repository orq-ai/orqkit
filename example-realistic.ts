import { Evaluatorq } from './packages/core/src/index.js';
import { CosineSimilarity, ExactMatch, LevenshteinDistance } from './packages/evaluators/src/index.js';

// More realistic example with actual evaluations
async function runRealisticExample() {
  const result = await Evaluatorq('AI Response Evaluation', {
    data: async () => {
      return [
        { 
          input: 'What is the capital of France?', 
          output: 'The capital of France is Paris.' 
        },
        { 
          input: 'What is the capital of France?', 
          output: 'Paris is the capital city of France.' 
        },
        { 
          input: 'What is 2+2?', 
          output: 'Two plus two equals four.' 
        },
        { 
          input: 'What is 2+2?', 
          output: '4' 
        },
        { 
          input: 'Tell me about TypeScript', 
          output: 'TypeScript is a programming language developed by Microsoft that adds static typing to JavaScript.' 
        },
        { 
          input: 'Tell me about TypeScript', 
          output: 'TypeScript is basically JavaScript with types. It was created by Microsoft.' 
        },
      ];
    },
    tasks: [
      // Task 1: Extract key information
      ({ input, output }) => {
        const keywords = output.toLowerCase().match(/\b\w+\b/g) || [];
        return {
          task: 'keyword_extraction',
          keywords: keywords.filter(w => w.length > 3),
          keywordCount: keywords.length,
        };
      },
      // Task 2: Length analysis
      ({ input, output }) => {
        return {
          task: 'length_analysis',
          inputLength: input.length,
          outputLength: output.length,
          lengthRatio: output.length / input.length,
        };
      },
    ],
    evaluators: [
      CosineSimilarity,
      ExactMatch,
      LevenshteinDistance,
    ],
  });

  console.log('\nEvaluation completed!');
  
  // Show some insights
  console.log('\n📊 Insights:');
  console.log('• Cosine Similarity is good for semantic similarity');
  console.log('• Exact Match shows when outputs are identical');
  console.log('• Levenshtein Distance measures character-level differences');
  
  return result;
}

// Run the example
runRealisticExample().catch(console.error);
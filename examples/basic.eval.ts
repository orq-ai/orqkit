import { Evaluatorq } from '@evaluatorq/core';
import { CosineSimilarity, ExactMatch, LevenshteinDistance } from '@evaluatorq/evaluators';

// Basic evaluation example
await Evaluatorq('Basic QA Evaluation', {
  data: async () => {
    // This could load from a file, database, or API
    return [
      { 
        input: 'What is the capital of France?',
        output: 'The capital of France is Paris.'
      },
      { 
        input: 'What is 2 + 2?',
        output: '2 + 2 equals 4.'
      },
      {
        input: 'Who wrote Romeo and Juliet?',
        output: 'William Shakespeare wrote Romeo and Juliet.'
      },
    ];
  },
  
  tasks: [
    // Analyze response characteristics
    ({ input, output }) => ({
      questionType: input.includes('What') ? 'what' : input.includes('Who') ? 'who' : 'other',
      responseLength: output.length,
      hasNumbers: /\d/.test(output),
      sentiment: output.length > 50 ? 'detailed' : 'concise',
    }),
  ],
  
  evaluators: [
    CosineSimilarity,
    ExactMatch,
    LevenshteinDistance,
  ],
});
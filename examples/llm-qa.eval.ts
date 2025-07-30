import { Evaluatorq } from '@evaluatorq/core';
import { CosineSimilarity, ExactMatch } from '@evaluatorq/evaluators';

// Example: Evaluating LLM responses to questions
// In a real scenario, you'd call your LLM API here

// Simulate LLM responses (replace with actual API calls)
async function getLLMResponse(question: string): Promise<string> {
  // This is where you'd call OpenAI, Claude, or other LLM APIs
  const responses = {
    'What is JavaScript?': 'JavaScript is a high-level, interpreted programming language used for web development.',
    'What is Node.js?': 'Node.js is a JavaScript runtime built on Chrome\'s V8 engine for server-side development.',
    'What is npm?': 'npm (Node Package Manager) is the default package manager for Node.js.',
  };
  
  return responses[question] || 'I don\'t know the answer to that question.';
}

// Expected answers for evaluation
const expectedAnswers = {
  'What is JavaScript?': 'JavaScript is a programming language commonly used for web development, both client-side and server-side.',
  'What is Node.js?': 'Node.js is a runtime environment that allows JavaScript to run on the server.',
  'What is npm?': 'npm is the package manager for JavaScript and Node.js ecosystems.',
};

await Evaluatorq('LLM Q&A Evaluation', {
  data: async () => {
    const questions = Object.keys(expectedAnswers);
    const results = [];
    
    for (const question of questions) {
      const llmResponse = await getLLMResponse(question);
      results.push({
        input: question,
        output: llmResponse,
      });
    }
    
    return results;
  },
  
  tasks: [
    ({ input, output }) => {
      const expected = expectedAnswers[input] || '';
      return {
        question: input,
        expectedAnswer: expected,
        actualAnswer: output,
        answerLength: output.length,
        containsKeyTerms: checkKeyTerms(input, output),
      };
    },
  ],
  
  evaluators: [
    // Compare against expected answers
    {
      name: 'ExpectedAnswerSimilarity',
      evaluate: (output, input) => {
        const expected = expectedAnswers[input] || '';
        // Use cosine similarity to compare with expected answer
        return CosineSimilarity.evaluate(output, expected);
      },
    },
    CosineSimilarity,
  ],
});

function checkKeyTerms(question: string, answer: string): boolean {
  const keyTerms = {
    'What is JavaScript?': ['programming', 'language', 'web'],
    'What is Node.js?': ['runtime', 'JavaScript', 'server'],
    'What is npm?': ['package', 'manager', 'Node'],
  };
  
  const terms = keyTerms[question] || [];
  const lowerAnswer = answer.toLowerCase();
  return terms.some(term => lowerAnswer.includes(term.toLowerCase()));
}
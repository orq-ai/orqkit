import { Effect } from 'effect';
import { Evaluator, EvaluatorError } from '@evaluatorq/shared';

// Simple TF-IDF implementation
function createVocabulary(texts: string[]): Set<string> {
  const vocabulary = new Set<string>();
  texts.forEach((text) => {
    const words = text.toLowerCase().split(/\s+/);
    words.forEach((word) => vocabulary.add(word));
  });
  return vocabulary;
}

function computeTF(text: string): Map<string, number> {
  const words = text.toLowerCase().split(/\s+/);
  const tf = new Map<string, number>();
  const totalWords = words.length;

  words.forEach((word) => {
    tf.set(word, (tf.get(word) || 0) + 1);
  });

  // Normalize by total words
  tf.forEach((count, word) => {
    tf.set(word, count / totalWords);
  });

  return tf;
}

function computeIDF(texts: string[], vocabulary: Set<string>): Map<string, number> {
  const idf = new Map<string, number>();
  const totalDocs = texts.length;

  vocabulary.forEach((word) => {
    const docsWithWord = texts.filter((text) =>
      text.toLowerCase().split(/\s+/).includes(word),
    ).length;
    idf.set(word, Math.log(totalDocs / (docsWithWord || 1)));
  });

  return idf;
}

function computeTFIDF(text: string, idf: Map<string, number>): Map<string, number> {
  const tf = computeTF(text);
  const tfidf = new Map<string, number>();

  tf.forEach((tfValue, word) => {
    const idfValue = idf.get(word) || 0;
    tfidf.set(word, tfValue * idfValue);
  });

  return tfidf;
}

function cosineSimilarity(vec1: Map<string, number>, vec2: Map<string, number>): number {
  const allWords = new Set([...vec1.keys(), ...vec2.keys()]);
  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  allWords.forEach((word) => {
    const val1 = vec1.get(word) || 0;
    const val2 = vec2.get(word) || 0;
    dotProduct += val1 * val2;
    norm1 += val1 * val1;
    norm2 += val2 * val2;
  });

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

export const CosineSimilarity: Evaluator<string> = {
  name: 'CosineSimilarity',
  evaluate: (output: string, expected: string) =>
    Effect.gen(function* () {
      // Handle edge cases
      if (!output || !expected) {
        return 0;
      }

      if (output === expected) {
        return 1;
      }

      // Simple TF vectors without IDF for single document comparison
      const tf1 = computeTF(output);
      const tf2 = computeTF(expected);

      // Compute cosine similarity directly on TF vectors
      const similarity = cosineSimilarity(tf1, tf2);

      // Ensure score is between 0 and 1
      return Math.max(0, Math.min(1, similarity));
    }).pipe(
      Effect.catchAll((error) =>
        Effect.fail(
          new EvaluatorError({
            evaluatorName: 'CosineSimilarity',
            message: 'Failed to compute cosine similarity',
            cause: error,
          }),
        ),
      ),
    ),
};
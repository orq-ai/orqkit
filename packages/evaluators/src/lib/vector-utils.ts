/**
 * Vector utilities for cosine similarity and dot product calculations
 *
 * thanks @alexanderop
 * @see https://alexop.dev/posts/how-to-implement-a-cosine-similarity-function-in-typescript-for-vector-comparison/
 */

/**
 * Calculates the cosine similarity between two vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error(
      `Vector dimensions don't match: ${vecA.length} vs ${vecB.length}`,
    );
  }

  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const magnitudeA = Math.hypot(...vecA);
  const magnitudeB = Math.hypot(...vecB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Calculates the dot product of two vectors
 */
export function dotProduct(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    throw new Error(
      `Vector dimensions don't match: ${vecA.length} vs ${vecB.length}`,
    );
  }

  return vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
}

/**
 * Calculates the magnitude (length) of a vector
 */
export function magnitude(vec: number[]): number {
  return Math.hypot(...vec);
}

/**
 * Normalizes a vector (converts to unit vector)
 */
export function normalize(vec: number[]): number[] {
  const mag = magnitude(vec);

  if (mag === 0) {
    return Array(vec.length).fill(0);
  }

  return vec.map((v) => v / mag);
}

/**
 * Converts cosine similarity to angular distance in degrees
 */
export function similarityToDegrees(similarity: number): number {
  // Clamp similarity to [-1, 1] to handle floating point errors
  const clampedSimilarity = Math.max(-1, Math.min(1, similarity));
  return Math.acos(clampedSimilarity) * (180 / Math.PI);
}

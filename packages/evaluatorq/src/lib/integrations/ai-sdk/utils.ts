/**
 * Generates a unique ID for OpenResponses items.
 */
export function generateItemId(prefix: string): string {
	const timestamp = Date.now().toString(36);
	const random = Math.random().toString(36).substring(2, 10);
	return `${prefix}_${timestamp}${random}`;
}

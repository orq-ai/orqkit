import consola from "consola";

export function formatJson(data: unknown): string {
	return JSON.stringify(data, null, 2);
}

export function printJson(data: unknown): void {
	console.log(formatJson(data));
}

export function printTable(headers: string[], rows: string[][]): void {
	const columnWidths = headers.map((header, i) => {
		const maxDataWidth = Math.max(...rows.map((row) => (row[i] || "").length));
		return Math.max(header.length, maxDataWidth);
	});

	const separator = columnWidths.map((w) => "-".repeat(w)).join(" | ");
	const headerRow = headers.map((h, i) => h.padEnd(columnWidths[i])).join(" | ");

	console.log(headerRow);
	console.log(separator);

	for (const row of rows) {
		const formattedRow = row.map((cell, i) => (cell || "").padEnd(columnWidths[i])).join(" | ");
		console.log(formattedRow);
	}
}

export function printSuccess(message: string): void {
	consola.success(message);
}

export function printError(message: string): void {
	consola.error(message);
}

export function printInfo(message: string): void {
	consola.info(message);
}

export function printWarn(message: string): void {
	consola.warn(message);
}

export function truncate(str: string, maxLength: number): string {
	if (str.length <= maxLength) return str;
	return `${str.slice(0, maxLength - 3)}...`;
}

import path from "node:path";

import { defineCommand } from "citty";
import { execa } from "execa";
import { glob } from "glob";

export default defineCommand({
	meta: {
		name: "evaluate",
		description: "Run evaluation files matching a glob pattern",
	},
	args: {
		pattern: {
			type: "positional",
			description: "Glob pattern to match evaluation files (e.g., **/*.eval.ts)",
			required: true,
		},
	},
	async run({ args }) {
		const matches = await glob(args.pattern, {
			absolute: true,
			ignore: ["**/node_modules/**", "**/dist/**"],
		});

		const evalFiles = matches.filter((file) => file.endsWith(".eval.ts"));

		if (evalFiles.length === 0) {
			console.log(`No evaluation files found matching pattern: ${args.pattern}`);
			console.log("Make sure your files end with .eval.ts");
			return;
		}

		console.log("Running evaluations:\n");

		for (const file of evalFiles) {
			const fileName = path.basename(file);
			console.log(`Running ${fileName}...`);

			try {
				await execa("tsx", [file], {
					preferLocal: true,
					cwd: process.cwd(),
					stdio: "inherit",
				});
				console.log(`${fileName} completed\n`);
			} catch (error) {
				console.error(`${fileName} failed`);
				if (error instanceof Error) {
					console.error(`   Error: ${error.message}\n`);
				}
			}
		}
	},
});

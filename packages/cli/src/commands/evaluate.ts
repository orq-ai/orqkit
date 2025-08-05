import path from "node:path";

import { execa } from "execa";
import { glob } from "glob";

interface EvaluateOptions {
  watch?: boolean;
}

export async function evaluate(pattern: string, _options: EvaluateOptions) {
  // Simply run with inherited stdio - let evaluatorq handle its own output
  const matches = await glob(pattern, {
    absolute: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
  });

  const evalFiles = matches.filter((file) => file.endsWith(".eval.ts"));

  if (evalFiles.length === 0) {
    console.log(`No evaluation files found matching pattern: ${pattern}`);
    console.log("Make sure your files end with .eval.ts");
    return;
  }

  console.log("Running evaluations:\n");

  for (const file of evalFiles) {
    const fileName = path.basename(file);
    console.log(`⚡ Running ${fileName}...`);

    try {
      await execa("tsx", [file], {
        preferLocal: true,
        cwd: process.cwd(),
        stdio: "inherit",
      });
      console.log(`✅ ${fileName} completed\n`);
    } catch (error) {
      console.error(`❌ ${fileName} failed`);
      if (error instanceof Error) {
        console.error(`   Error: ${error.message}\n`);
      }
    }
  }
}

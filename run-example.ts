#!/usr/bin/env bun

// Add module aliases for bun
import { pathToFileURL } from "url";

const aliases = {
  "@evaluatorq/shared": "./packages/shared/src/index.ts",
  "@evaluatorq/core": "./packages/core/src/index.ts", 
  "@evaluatorq/evaluators": "./packages/evaluators/src/index.ts",
};

// Register aliases with Bun
for (const [alias, path] of Object.entries(aliases)) {
  // @ts-ignore
  Bun.plugin({
    name: alias,
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${alias}$`) }, () => ({
        path: new URL(path, import.meta.url).href,
      }));
    },
  });
}

// Now import and run the example
await import("./example-comparison.ts");
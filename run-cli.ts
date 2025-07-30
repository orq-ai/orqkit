#!/usr/bin/env bun

// Setup module aliases for development
const aliases = {
  "@evaluatorq/shared": "./packages/shared/src/index.ts",
  "@evaluatorq/core": "./packages/core/src/index.ts",
  "@evaluatorq/evaluators": "./packages/evaluators/src/index.ts",
  "@evaluatorq/cli": "./packages/cli/src/index.ts",
  "@evaluatorq/orq-integration": "./packages/orq-integration/src/index.ts",
};

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

// Run CLI
await import("./packages/cli/src/lib/cli.ts");
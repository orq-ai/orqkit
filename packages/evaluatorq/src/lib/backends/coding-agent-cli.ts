import { spawn } from "node:child_process";

import {
  CODING_AGENT_BUILD_DIR,
  cliPrefix,
  DEFAULT_CODING_AGENT_IMAGE,
  pyRepr,
} from "./container.js";

export interface BuildImageOptions {
  tag?: string;
  binary?: string;
  context?: string | null;
  buildArgs?: readonly string[];
}

/** A usage error, which the Python CLI reports with exit code 2. */
export class BuildImageError extends Error {
  readonly exitCode = 2;
}

/** The `build` command for the coding-agent image shipped in `static/coding-agent-docker`. */
export function buildImageArgv(options: BuildImageOptions = {}): string[] {
  const args = (options.buildArgs ?? []).flatMap((pair) => [
    "--build-arg",
    pair,
  ]);
  return [
    ...cliPrefix(options.binary ?? "docker", options.context ?? null),
    "build",
    "-t",
    options.tag ?? DEFAULT_CODING_AGENT_IMAGE,
    ...args,
    CODING_AGENT_BUILD_DIR,
  ];
}

/** Build the default coding-agent image and resolve with the container CLI's exit code. */
export function buildImage(options: BuildImageOptions = {}): Promise<number> {
  const [command, ...rest] = buildImageArgv(options);
  const binary = options.binary ?? "docker";
  return new Promise((done, fail) => {
    const child = spawn(command as string, rest, { stdio: "inherit" });
    child.on("error", (error: NodeJS.ErrnoException) =>
      fail(
        error.code === "ENOENT"
          ? new BuildImageError(`${pyRepr(binary)} not found on PATH`)
          : error,
      ),
    );
    child.on("close", (code) => done(code ?? 1));
  });
}

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write `source` as a JS fake named `name` in `dir`, run by the current bun, and return its launcher. */
export function installFake(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, `${name}.js`);
  writeFileSync(script, source);
  const launcher = join(dir, name);
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

/** Drains stdin, echoes $FAKE_STDOUT and exits with $FAKE_EXIT. */
export const ECHO = `
const fs = require("node:fs");
try { fs.readFileSync(0); } catch {}
if (process.env.FAKE_STDOUT) process.stdout.write(fs.readFileSync(process.env.FAKE_STDOUT));
process.exitCode = Number(process.env.FAKE_EXIT || 0);
`;

/** Starts a long-lived child, publishes its pid in $FAKE_PIDFILE and waits on it. */
export const SLEEPER = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], { stdio: "ignore" });
fs.writeFileSync(process.env.FAKE_PIDFILE + ".tmp", String(child.pid));
fs.renameSync(process.env.FAKE_PIDFILE + ".tmp", process.env.FAKE_PIDFILE);
child.on("exit", () => process.exit(0));
`;

export function withEnv(
  values: Record<string, string | undefined>,
): () => void {
  const saved = Object.fromEntries(
    Object.keys(values).map((k) => [k, process.env[k]]),
  );
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

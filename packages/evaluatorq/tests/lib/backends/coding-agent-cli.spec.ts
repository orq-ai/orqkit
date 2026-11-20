import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BuildImageError,
  buildImage,
} from "../../../src/lib/backends/coding-agent-cli.js";
import {
  CODING_AGENT_BUILD_DIR,
  DEFAULT_CODING_AGENT_IMAGE,
} from "../../../src/lib/backends/container.js";
import { installFake } from "./fakes.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evq-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("buildImage passes the argv through and returns the exit code", async () => {
  const log = join(dir, "log");
  const fake = installFake(
    dir,
    "docker",
    `require("node:fs").writeFileSync(${JSON.stringify(log)}, process.argv.slice(2).map((a) => "[" + a + "]\\n").join("")); process.exitCode = 3;`,
  );
  const code = await buildImage({
    binary: fake,
    context: "orbstack",
    tag: "custom:tag",
    buildArgs: ["CODEX_VERSION=1.2.3", "CLAUDE_CODE_VERSION=2.1.282"],
  });
  expect(code).toBe(3);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "[--context]",
    "[orbstack]",
    "[build]",
    "[-t]",
    "[custom:tag]",
    "[--build-arg]",
    "[CODEX_VERSION=1.2.3]",
    "[--build-arg]",
    "[CLAUDE_CODE_VERSION=2.1.282]",
    `[${CODING_AGENT_BUILD_DIR}]`,
  ]);
  expect(await buildImage({ binary: fake })).toBe(3);
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "[build]",
    "[-t]",
    `[${DEFAULT_CODING_AGENT_IMAGE}]`,
    `[${CODING_AGENT_BUILD_DIR}]`,
  ]);
});

test("a missing binary is a usage error", async () => {
  const missing = join(dir, "missing-docker");
  const error = await buildImage({ binary: missing }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BuildImageError);
  expect((error as BuildImageError).exitCode).toBe(2);
  expect((error as Error).message).toBe(`'${missing}' not found on PATH`);
});

test("the build dir ships both files", () => {
  expect(existsSync(join(CODING_AGENT_BUILD_DIR, "Dockerfile"))).toBe(true);
  expect(existsSync(join(CODING_AGENT_BUILD_DIR, "entrypoint.sh"))).toBe(true);
});

test("the entrypoint uses a private passwd copy and execs idempotently", () => {
  const passwd = join(dir, "passwd");
  const originalPasswd = "root:x:0:0::/root:/bin/sh\n";
  writeFileSync(passwd, originalPasswd);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "id"),
    `#!/bin/sh\ncase "$1" in\n  -un) if grep -q '^evq:x:4242:4242:' "\${NSS_WRAPPER_PASSWD:-${passwd}}"; then echo evq; else exit 1; fi ;;\n  -u) echo 4242 ;;\n  -g) echo 4242 ;;\nesac\n`,
  );
  chmodSync(join(bin, "id"), 0o755);
  const script = join(dir, "entrypoint.sh");
  // Dynamic NSS resolution is checked in the real image; this fixture checks its file lifecycle.
  writeFileSync(
    script,
    readFileSync(join(CODING_AGENT_BUILD_DIR, "entrypoint.sh"), "utf8")
      .replaceAll("/etc/passwd", passwd)
      .replace(/^ {2}export LD_PRELOAD=.*\n/m, ""),
  );
  for (let i = 0; i < 2; i++) {
    const out = spawnSync(
      "sh",
      [
        script,
        "sh",
        "-c",
        'sh "$EVQ_SCRIPT" sh -c \'printf "%s\\n" "$NSS_WRAPPER_PASSWD"; echo ran\'',
      ],
      {
        encoding: "utf8",
        env: {
          HOME: "/evq-home",
          PATH: `${bin}:/usr/bin:/bin`,
          TMPDIR: dir,
          EVQ_SCRIPT: script,
        },
      },
    );
    expect(out.status).toBe(0);
    const [copy, ran] = out.stdout.trim().split("\n");
    expect(ran).toBe("ran");
    expect(copy).not.toBe(passwd);
    expect(
      readFileSync(copy as string, "utf8").split("evq:x:4242:4242:").length - 1,
    ).toBe(1);
    expect(statSync(copy as string).mode & 0o777).toBe(0o600);
    expect(readFileSync(passwd, "utf8")).toBe(originalPasswd);
  }
});

import {
  afterEach,
  beforeEach,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CodingAgentError,
  CodingAgentTarget,
  type CodingAgentTargetOptions,
} from "../../../src/lib/backends/coding-agent.js";
import {
  containerRuntime,
  LIVE_CONTAINERS,
} from "../../../src/lib/backends/container.js";
import { type Message, MessageSchema } from "../../../src/lib/contracts.js";
import { installFake, withEnv } from "./fakes.js";

const FAKE = `
const fs = require("node:fs");
const env = process.env;
let args = process.argv.slice(2);
const log = (line) => fs.appendFileSync(env.FAKE_LOG, line + "\\n");
const sleep = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
log("ARGV " + args.join(" "));
if (args[0] === "--context") args = args.slice(2);
const sub = args[0] ?? "";
if (sub === "image") {
  if (env.FAKE_IMAGE_ERROR) process.stderr.write(env.FAKE_IMAGE_ERROR + "\\n");
  process.exit(Number(env.FAKE_IMAGE_EXIT || 0));
}
if (sub === "ps") process.exit(0);
if (sub === "run") {
  if (env.FAKE_RUN_SLEEP) sleep(Number(env.FAKE_RUN_SLEEP));
  if (env.FAKE_RUN_EXIT) { process.stderr.write("daemon down\\n"); process.exit(Number(env.FAKE_RUN_EXIT)); }
  log("CREATED");
  if (env.FAKE_RUN_STOPPED) fs.writeFileSync(env.FAKE_STOPPED, "");
  console.log("cid");
}
if (sub === "inspect") {
  if (env.FAKE_AFTER_EXEC && fs.existsSync(env.FAKE_AFTER_EXEC)) {
    if (env.FAKE_EXEC_STATE === "missing") { process.stderr.write("Error: No such container: fixture\\n"); process.exit(1); }
    if (env.FAKE_EXEC_STATE === "unavailable") { process.stderr.write("Cannot connect to the Docker daemon\\n"); process.exit(1); }
    if (env.FAKE_EXEC_STATE === "stopped") { console.log("false"); process.exit(0); }
  }
  if (env.FAKE_STOPPED && fs.existsSync(env.FAKE_STOPPED)) { fs.unlinkSync(env.FAKE_STOPPED); console.log("false"); }
  else console.log("true");
}
if (sub === "exec") {
  if (env.FAKE_AFTER_EXEC) fs.writeFileSync(env.FAKE_AFTER_EXEC, "");
  log(Object.entries(env).map(([k, v]) => "ENV " + k + "=" + v).join("\\n"));
  try { fs.readFileSync(0); } catch {}
  if (env.FAKE_EXEC_SLEEP) sleep(Number(env.FAKE_EXEC_SLEEP));
  if (env.FAKE_STDOUT) process.stdout.write(fs.readFileSync(env.FAKE_STDOUT));
  process.exit(Number(env.FAKE_EXEC_EXIT || 0));
}
if (sub === "rm") {
  if (env.FAKE_RM_EXIT) process.exit(Number(env.FAKE_RM_EXIT));
  log("REMOVED");
}
`;

const FIXTURES = join(import.meta.dir, "fixtures");
const original = { ...containerRuntime };
let dir: string;
let docker: string;
let restore: () => void;
let warn: Mock<typeof console.warn>;
const targets: CodingAgentTarget[] = [];
const user: Message[] = [MessageSchema.parse({ role: "user", content: "hi" })];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "evq-docker-")));
  docker = installFake(dir, "docker", FAKE);
  restore = withEnv({
    FAKE_LOG: join(dir, "log"),
    FAKE_STDOUT: join(FIXTURES, "claude_tool.jsonl"),
  });
  containerRuntime.installExitHooks = () => {};
  containerRuntime.startHeartbeat = () => {};
  warn = spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const t of targets.splice(0)) await t.close();
  restore();
  Object.assign(containerRuntime, original);
  LIVE_CONTAINERS.clear();
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function target(
  opts: Record<string, unknown> = {},
  kw: CodingAgentTargetOptions = {},
): CodingAgentTarget {
  const t = new CodingAgentTarget("claude", {
    ...kw,
    container: { binary: docker, image: "img:1", ...opts },
  });
  targets.push(t);
  return t;
}

function lines(): string[] {
  const path = join(dir, "log");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
}
const calls = (sub: string) =>
  lines().filter((l) => l.startsWith("ARGV") && ` ${l} `.includes(` ${sub} `));
const count = (text: string) => lines().filter((l) => l === text).length;

async function failure(promise: Promise<unknown>): Promise<CodingAgentError> {
  try {
    await promise;
  } catch (error) {
    return error as CodingAgentError;
  }
  throw new Error("expected a failure");
}

test("turns run in one container and close removes it", async () => {
  const t = target({ context: "orbstack" });
  await t.respond(user);
  await t.respond(user);
  expect(calls("run")).toHaveLength(1);
  expect(calls("exec")).toHaveLength(2);
  expect(calls("image")).toHaveLength(1);
  expect(calls("ps")).toHaveLength(1);
  expect(calls("exec")[0]).toContain("--permission-mode bypassPermissions");
  expect(LIVE_CONTAINERS.size).toBe(1);
  await t.close();
  expect(count("REMOVED")).toBe(1);
  expect(LIVE_CONTAINERS.size).toBe(0);
});

test("caller env overrides host env for container exec and is forwarded by name", async () => {
  const restoreHost = withEnv({ ANTHROPIC_API_KEY: "host-value" });
  try {
    await target({}, { env: { ANTHROPIC_API_KEY: "caller-value" } }).respond(
      user,
    );
  } finally {
    restoreHost();
  }
  expect(lines()).toContain("ENV ANTHROPIC_API_KEY=caller-value");
  expect(calls("exec")[0]).toContain("-e ANTHROPIC_API_KEY");
  expect(calls("exec")[0]).not.toContain("caller-value");
});

for (const error of [
  "Error: No such image: img:1",
  "Error: No such object: img:1",
  "image not known",
])
  test(`image missing: ${error}`, async () => {
    const r = withEnv({ FAKE_IMAGE_EXIT: "1", FAKE_IMAGE_ERROR: error });
    try {
      const e = await failure(target().respond(user));
      expect(e.code).toBe("cli.image_missing");
      expect(e.detail).toContain("build -t img:1");
      expect(e.detail).not.toContain("eq coding-agent");
      expect(calls("run")).toHaveLength(0);
    } finally {
      r();
    }
  });

test("image inspect failing for another reason is container_start", async () => {
  const r = withEnv({
    FAKE_IMAGE_EXIT: "1",
    FAKE_IMAGE_ERROR: "context orbstack not found",
  });
  try {
    const e = await failure(target().respond(user));
    expect([e.code, e.detail]).toEqual([
      "cli.container_start",
      `${docker} image inspect failed: context orbstack not found`,
    ]);
  } finally {
    r();
  }
});

test("a failed run is container_start and unregisters the name", async () => {
  const r = withEnv({ FAKE_RUN_EXIT: "125" });
  try {
    const e = await failure(target().respond(user));
    expect([e.code, e.detail]).toEqual([
      "cli.container_start",
      `${docker} run failed: daemon down`,
    ]);
    expect(LIVE_CONTAINERS.size).toBe(0);
  } finally {
    r();
  }
});

test("a missing docker binary is not_found", async () => {
  const t = new CodingAgentTarget("claude", {
    container: { binary: join(dir, "nope") },
  });
  targets.push(t);
  const e = await failure(t.respond(user));
  expect(e.code).toBe("cli.not_found");
  expect(LIVE_CONTAINERS.size).toBe(0);
});

test("a container that exits immediately is removed", async () => {
  const r = withEnv({
    FAKE_RUN_STOPPED: "1",
    FAKE_STOPPED: join(dir, "stopped"),
  });
  try {
    const e = await failure(target().respond(user));
    expect(e.code).toBe("cli.container_start");
    expect(e.detail).toContain("was not running: false");
    expect(count("REMOVED")).toBe(1);
  } finally {
    r();
  }
});

for (const [exit, code] of [
  ["127", "cli.agent_not_found"],
  ["126", "cli.agent_not_found"],
  ["137", "cli.exit.137"],
  ["2", "cli.exit.2"],
] as const)
  test(`exec exit ${exit} is ${code} and removes the container`, async () => {
    const r = withEnv({ FAKE_EXEC_EXIT: exit });
    try {
      const e = await failure(target().respond(user));
      expect(e.code).toBe(code);
      if (exit === "137") expect(e.killReason).toBeNull();
      expect(count("REMOVED")).toBe(1);
      expect(LIVE_CONTAINERS.size).toBe(0);
    } finally {
      r();
    }
  });

for (const state of ["stopped", "missing", "unavailable"] as const)
  test(`exec exit 137 distinguishes ${state} container state`, async () => {
    const restore = withEnv({
      FAKE_EXEC_EXIT: "137",
      FAKE_EXEC_STATE: state,
      FAKE_AFTER_EXEC: join(dir, "after-exec"),
    });
    try {
      const error = await failure(target().respond(user));
      expect(error.code).toBe(
        state === "unavailable" ? "cli.exit.137" : "cli.timeout",
      );
      expect(error.killReason).toBe(
        state === "unavailable" ? null : "container_lost",
      );
      if (state === "unavailable")
        expect(error.detail).toContain("container state: unavailable");
      expect(count("REMOVED")).toBe(1);
      expect(LIVE_CONTAINERS.size).toBe(0);
    } finally {
      restore();
    }
  });

test("empty agent output removes the container", async () => {
  const empty = join(dir, "empty");
  writeFileSync(empty, "");
  const r = withEnv({ FAKE_STDOUT: empty });
  try {
    expect((await failure(target().respond(user))).code).toBe("cli.no_result");
    expect(count("REMOVED")).toBe(1);
  } finally {
    r();
  }
});

test("idle timeout removes the container", async () => {
  const r = withEnv({ FAKE_EXEC_SLEEP: "5" });
  try {
    const e = await failure(target({}, { timeoutMs: 300 }).respond(user));
    expect(e.killReason).toBe("idle_timeout");
    expect(count("REMOVED")).toBe(1);
  } finally {
    r();
  }
});

test("abort during the run removes the container before rejecting", async () => {
  const r = withEnv({ FAKE_EXEC_SLEEP: "5" });
  try {
    const controller = new AbortController();
    const pending = failure(
      target().respond(user, { signal: controller.signal }),
    );
    while (calls("exec").length === 0) await Bun.sleep(10);
    controller.abort();
    await pending;
    expect(count("REMOVED")).toBe(1);
    expect(LIVE_CONTAINERS.size).toBe(0);
  } finally {
    r();
  }
});

for (const [marker, reason] of [
  [true, "lease_expired"],
  [false, "container_lost"],
] as const)
  test(`restart between turns logs ${reason}`, async () => {
    const t = target();
    await t.respond(user);
    const root = join(t.workdir as string, "..");
    if (marker)
      writeFileSync(join(root, "home", ".evq-exit"), "lease_expired now\n");
    writeFileSync(join(dir, "stopped"), "");
    const r = withEnv({ FAKE_STOPPED: join(dir, "stopped") });
    try {
      await t.respond(user);
    } finally {
      r();
    }
    expect(calls("run")).toHaveLength(2);
    expect(count("REMOVED")).toBe(1);
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes(`claude) ${reason}: container`),
      ),
    ).toBe(true);
    expect(existsSync(join(root, "home", ".evq-exit"))).toBe(false);
  });

test("ten clones run concurrently in their own containers", async () => {
  const base = target();
  const clones = Array.from({ length: 10 }, () => base.newInstance());
  targets.push(...clones);
  await Promise.all(clones.map((c) => c.respond(user)));
  expect(calls("run")).toHaveLength(10);
  expect(new Set(clones.map((c) => c.workdir)).size).toBe(10);
});

test("keepWorkdir outlives the container", async () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  const t = target({}, { keepWorkdir: true });
  await t.respond(user);
  const work = t.workdir as string;
  await t.close();
  expect(existsSync(work)).toBe(true);
  expect(existsSync(join(work, "..", "lease"))).toBe(false);
  info.mockRestore();
});

test("skills are copied, not linked", async () => {
  const skill = join(dir, "skill-a");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "x");
  const t = target({}, { skills: [skill] });
  await t.respond(user);
  const copied = join(t.workdir as string, ".claude/skills/skill-a");
  expect(lstatSync(copied).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(copied, "SKILL.md"), "utf8")).toBe("x");
});

test("an unsafe mount warns before the run", async () => {
  await target({ runArgs: ["-v", "/:/host"] }).respond(user);
  expect(
    warn.mock.calls.some((c) =>
      String(c[0]).includes("mount source '/' is outside"),
    ),
  ).toBe(true);
});

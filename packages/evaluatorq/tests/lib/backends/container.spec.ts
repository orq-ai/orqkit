import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  spyOn,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  BEAT_WARNED,
  buildExecArgv,
  buildRunArgv,
  containerRuntime,
  DEFAULT_CODING_AGENT_IMAGE,
  dockerOptions,
  forwardedEnvNames,
  heartbeatOnce,
  isolationBreakingFlags,
  LIVE_CONTAINERS,
  makeSignalHandler,
  pidAlive,
  pyRepr,
  rawEnvironmentFlags,
  register,
  releaseContainers,
  removeAll,
  removeContainers,
  removeContainersAsync,
  shellJoin,
  sweepOrphans,
  unregister,
  unsafeMounts,
  validateManagedRunArgs,
  watchdogScript,
  writeBeat,
} from "../../../src/lib/backends/container.js";
import goldens from "./fixtures/coding-agent-python-goldens.json" with {
  type: "json",
};

const c = goldens.container;
const original = { ...containerRuntime };
let dir: string;
let warn: Mock<typeof console.warn>;
let error: Mock<typeof console.error>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "evq-container-"));
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  containerRuntime.installExitHooks = () => {};
  containerRuntime.startHeartbeat = () => {};
});

afterEach(() => {
  Object.assign(containerRuntime, original);
  LIVE_CONTAINERS.clear();
  BEAT_WARNED.clear();
  warn.mockRestore();
  error.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function fakeDocker(body: string): string {
  const path = join(dir, "docker");
  writeFileSync(path, `#!/bin/sh\necho "$@" >> "${dir}/calls"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function calls(): string[] {
  try {
    return readFileSync(join(dir, "calls"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
}

describe("python goldens", () => {
  test("isolation, raw env and mounts", () => {
    for (const g of c.isolation)
      expect(isolationBreakingFlags(g.input)).toEqual(g.expected);
    for (const g of c.raw_env)
      expect(rawEnvironmentFlags(g.input)).toEqual(g.expected);
    for (const g of c.mounts)
      expect(unsafeMounts(g.input, g.root)).toEqual(g.expected);
  });

  test("managed run arg validation", () => {
    for (const g of c.validation) {
      const run = () =>
        validateManagedRunArgs(g.input, { allowPrivilegeEscalation: g.allow });
      if (g.ok) expect(run).not.toThrow();
      else expect(run).toThrow(g.error as string);
    }
  });

  test("options validation and warnings", () => {
    for (const g of c.options) {
      warn.mockClear();
      if (g.ok) {
        dockerOptions(g.input as never);
        expect(warn.mock.calls.map((call) => call[0])).toEqual(g.warnings);
        continue;
      }
      const expected = /Value error, (.*?) \[type=/s.exec(
        g.error as string,
      )?.[1];
      let message = "";
      try {
        dockerOptions(g.input as never);
      } catch (e) {
        message =
          (e as { issues: { message: string }[] }).issues[0]?.message ?? "";
      }
      expect(message).toBe(expected as string);
    }
  });

  test("forwarded env names", () => {
    for (const g of c.env) {
      const hostEnv = Object.fromEntries(g.host_env.map((k) => [k, "x"]));
      expect(
        forwardedEnvNames(dockerOptions(g.options as never), {
          launcher: g.launcher,
          providerEnv: g.provider_env,
          callerEnv: g.caller_env as Record<string, string>,
          hostEnv,
        }),
      ).toEqual(g.expected);
    }
  });

  test("run and exec argv, watchdog", () => {
    for (const g of c.run_argv) {
      const expected = g.expected.map((a) =>
        a
          .replace("{PID}", String(process.pid))
          .replace("{HOST}", hostname())
          .replace(/^evaluatorq-coding-agent:.*/, DEFAULT_CODING_AGENT_IMAGE),
      );
      const root = "/evq-golden-root";
      expect(
        buildRunArgv(dockerOptions(g.options as never), {
          name: "evq-claude-abcd1234",
          root,
          leaseDir: join(root, "lease", "n"),
          uid: 501,
          gid: 20,
        }),
      ).toEqual(expected);
    }
    expect(watchdogScript()).toBe(c.watchdog);
    expect(watchdogScript(2)).toBe(c.watchdog_2);
    expect(
      buildExecArgv(dockerOptions({ context: "ctx", workdir: "/app" }), {
        name: "n",
        envNames: ["A", "B"],
        agentArgv: ["claude", "-p"],
      }),
    ).toEqual(c.exec_argv);
  });
});

test("options accept camelCase and are frozen", () => {
  const opts = dockerOptions({ namePrefix: "x", runArgs: ["--cpus", "2"] });
  expect(opts.namePrefix).toBe("x");
  expect(Object.isFrozen(opts)).toBe(true);
  expect(Object.isFrozen(opts.runArgs)).toBe(true);
});

test("pyRepr and shellJoin", () => {
  expect(pyRepr("a'b")).toBe(`"a'b"`);
  expect(pyRepr("a\nb")).toBe("'a\\nb'");
  expect(shellJoin(["docker", "rm", "-f", "a b", "", "it's"])).toBe(
    `docker rm -f 'a b' '' 'it'"'"'s'`,
  );
});

test("removeContainers batches, retries once, then reports a manual command", () => {
  const docker = fakeDocker('echo "Error: boom a" >&2; exit 1');
  expect(removeContainers(docker, "ctx", ["a", "a"])).toEqual(["a"]);
  expect(calls()).toEqual(["--context ctx rm -f a", "--context ctx rm -f a"]);
  expect(String(error.mock.calls[0]?.[0])).toContain(
    `${docker} --context ctx rm -f a`,
  );
});

test("removeContainers treats missing containers as removed", () => {
  const docker = fakeDocker(
    'for n in "$@"; do case $n in rm|-f) ;; *) echo "Error: No such container: $n" >&2;; esac; done; exit 1',
  );
  expect(removeContainers(docker, null, ["a", "b"])).toEqual([]);
  expect(calls()).toHaveLength(1);
});

test("removeContainers retries only the names that failed", () => {
  const docker = fakeDocker(
    'echo "Error: No such container: a" >&2; echo "Error: cannot remove b" >&2; exit 1',
  );
  expect(removeContainers(docker, null, ["a", "b"])).toEqual(["b"]);
  expect(calls()).toEqual(["rm -f a b", "rm -f b"]);
});

test("removeContainers reports a missing binary", () => {
  expect(removeContainers(join(dir, "nope"), null, ["a"])).toEqual(["a"]);
  expect(error).toHaveBeenCalledTimes(1);
});

test("removeContainersAsync matches the sync rules", async () => {
  const docker = fakeDocker("exit 0");
  expect(await removeContainersAsync(docker, null, ["a"])).toEqual([]);
  const failing = fakeDocker('echo "Error: x a" >&2; exit 1');
  expect(await removeContainersAsync(failing, null, ["a"])).toEqual(["a"]);
});

test("register, unregister and removeAll group by binary and context", () => {
  const removed: [string, string | null, string[]][] = [];
  containerRuntime.removeContainers = (binary, context, names) => {
    removed.push([binary, context, [...names]]);
    return [];
  };
  register("a", { binary: "docker", context: null, beat: "x" });
  register("b", { binary: "docker", context: null, beat: "x" });
  register("c", { binary: "podman", context: null, beat: "x" });
  expect(unregister("missing")).toBeNull();
  removeAll("atexit");
  expect(removed).toEqual([
    ["docker", null, ["a", "b"]],
    ["podman", null, ["c"]],
  ]);
  expect(LIVE_CONTAINERS.size).toBe(0);
});

test("removeAll stops at the cleanup deadline", () => {
  let now = 0;
  containerRuntime.monotonic = () => now;
  containerRuntime.removeContainers = () => {
    now += 10;
    return [];
  };
  register("a", { binary: "docker", context: null, beat: "x" });
  register("b", { binary: "podman", context: null, beat: "x" });
  removeAll("SIGTERM", { maxCleanupS: 5 });
  expect(
    warn.mock.calls.some((call) =>
      String(call[0]).includes("deadline reached"),
    ),
  ).toBe(true);
});

test("releaseContainers removes only still-registered names", () => {
  const removed: string[] = [];
  containerRuntime.removeContainers = (_b, _c, names) => {
    removed.push(...names);
    return [];
  };
  register("a", { binary: "docker", context: null, beat: "x" });
  releaseContainers(["a", "gone"]);
  expect(removed).toEqual(["a"]);
});

test("signal handler cleans up then chains to the previous handler", () => {
  const seen: string[] = [];
  containerRuntime.removeContainers = (_b, _c, names) => {
    seen.push(...names);
    return [];
  };
  register("a", { binary: "docker", context: null, beat: "x" });
  makeSignalHandler((signal) => seen.push(signal))("SIGTERM");
  expect(seen).toEqual(["a", "SIGTERM"]);
});

test("writeBeat and heartbeatOnce warn once per failing lease", () => {
  const beat = join(dir, "beat");
  writeBeat(beat, 3);
  expect(readFileSync(beat, "utf8")).toBe("3");
  register("ok", { binary: "docker", context: null, beat });
  register("bad", {
    binary: "docker",
    context: null,
    beat: join(dir, "missing", "beat"),
  });
  heartbeatOnce(4);
  heartbeatOnce(5);
  expect(readFileSync(beat, "utf8")).toBe("5");
  expect(warn).toHaveBeenCalledTimes(1);
  mkdirSync(join(dir, "missing"));
  heartbeatOnce(6);
  expect(BEAT_WARNED.has("bad")).toBe(false);
});

test("pidAlive", () => {
  expect(pidAlive(process.pid)).toBe(true);
  expect(pidAlive(2 ** 22 + 12345)).toBe(false);
});

test("sweepOrphans removes dead same-host containers only", async () => {
  const lines = [
    `dead\t${2 ** 22 + 12345}\t${hostname()}`,
    `live\t${process.pid}\t${hostname()}`,
    `other\t${2 ** 22 + 12345}\tsomewhere-else`,
    `bad\tnope\t${hostname()}`,
  ].join("\\n");
  const docker = fakeDocker(
    `case "$1" in ps) printf '${lines}\\n';; esac; exit 0`,
  );
  await sweepOrphans(docker, null);
  expect(calls().at(-1)).toBe("rm -f dead");
  expect(
    warn.mock.calls.some((call) =>
      String(call[0]).includes("unreadable host-pid"),
    ),
  ).toBe(true);
});

test("sweepOrphans warns and skips when ps fails", async () => {
  const docker = fakeDocker('echo "daemon down" >&2; exit 1');
  await sweepOrphans(docker, null);
  expect(calls()).toHaveLength(1);
  expect(String(warn.mock.calls[0]?.[0])).toBe(
    "orphan sweep skipped: daemon down",
  );
});

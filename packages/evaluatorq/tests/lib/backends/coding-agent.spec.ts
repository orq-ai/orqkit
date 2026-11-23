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
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodingAgentError,
  CodingAgentTarget,
  CodingAgentUnavailableError,
  codingAgentRuntime,
  refuseUnsafeBatchArgs,
} from "../../../src/lib/backends/coding-agent.js";
import { pidAlive } from "../../../src/lib/backends/container.js";
import { NonRetryableTargetError } from "../../../src/lib/common/target-call.js";
import { type Message, MessageSchema } from "../../../src/lib/contracts.js";
import { ECHO, installFake, SLEEPER } from "./fakes.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const runtime = { ...codingAgentRuntime };
let dir: string;
let warn: Mock<typeof console.warn>;
const targets: CodingAgentTarget[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "evq-agent-")));
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  for (const target of targets.splice(0)) await target.close();
  Object.assign(codingAgentRuntime, runtime);
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const user: Message[] = [MessageSchema.parse({ role: "user", content: "hi" })];

function target(
  agent: "claude" | "codex" | "opencode",
  source: string,
  env: Record<string, string> = {},
  options: ConstructorParameters<typeof CodingAgentTarget>[1] = {},
): CodingAgentTarget {
  const bin = join(dir, "bin");
  installFake(bin, agent, source);
  const t = new CodingAgentTarget(agent, {
    ...options,
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env },
  });
  targets.push(t);
  return t;
}

async function failure(promise: Promise<unknown>): Promise<CodingAgentError> {
  try {
    await promise;
  } catch (error) {
    return error as CodingAgentError;
  }
  throw new Error("expected a failure");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

const fixture = (name: string) => join(FIXTURES, `${name}.jsonl`);
const PRINT_LOOP = (
  ms: number,
  count: number,
  stream = "stdout",
  then = "",
) => `
let n = 0;
const timer = setInterval(() => {
  process.${stream}.write("{\\"type\\":\\"tick\\"}\\n");
  if (++n >= ${count}) { clearInterval(timer); ${then} }
}, ${ms});
`;

describe("respond", () => {
  test("claude success carries tool calls, text, usage and model", async () => {
    const r = await target("claude", ECHO, {
      FAKE_STDOUT: fixture("claude_tool"),
    }).respond(user);
    expect(r.output.map((o) => o.type)).toEqual([
      "function_call",
      "output_text",
    ]);
    expect(r.output.at(-1)).toMatchObject({ text: "done" });
    expect(r.usage?.inputTokens).toBe(4);
    expect(r.model).toBe("claude-opus-5");
    expect(r.responseId).toBe("9c0bf077-5b29-4b47-9953-3dd93ce096c9");
  });

  for (const [agent, name] of [
    ["codex", "codex_tool"],
    ["opencode", "opencode_tool"],
    ["opencode", "opencode_text"],
  ] as const)
    test(`${agent} ${name} succeeds`, async () => {
      const r = await target(agent, ECHO, {
        FAKE_STDOUT: fixture(name),
      }).respond(user);
      expect(r.output.at(-1)?.type).toBe("output_text");
    });

  test("nonzero exit wins over a parsed result and is retryable", async () => {
    const e = await failure(
      target("claude", ECHO, {
        FAKE_STDOUT: fixture("claude_tool"),
        FAKE_EXIT: "3",
      }).respond(user),
    );
    expect(e.code).toBe("cli.exit.3");
    expect(e).toBeInstanceOf(CodingAgentError);
    expect(e).not.toBeInstanceOf(NonRetryableTargetError);
  });

  test("exit 0 with empty stdout is no_result", async () => {
    expect((await failure(target("claude", ECHO).respond(user))).code).toBe(
      "cli.no_result",
    );
  });

  test("a non-JSON banner after the final event is skipped", async () => {
    const out = join(dir, "out");
    writeFileSync(
      out,
      `${readFileSync(fixture("claude_tool"), "utf8")}\nUpdate available!\n`,
    );
    const r = await target("claude", ECHO, { FAKE_STDOUT: out }).respond(user);
    expect(r.output.at(-1)).toMatchObject({ text: "done" });
  });

  test("garbage stdout is a parse error", async () => {
    const out = join(dir, "out");
    writeFileSync(out, "not json at all\n");
    expect(
      (
        await failure(
          target("claude", ECHO, { FAKE_STDOUT: out }).respond(user),
        )
      ).code,
    ).toBe("cli.parse_error");
  });

  test("an empty agent message is no_result and is_error is agent_error", async () => {
    const empty = join(dir, "empty");
    writeFileSync(
      empty,
      '{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"  "}}\n',
    );
    expect(
      (
        await failure(
          target("codex", ECHO, { FAKE_STDOUT: empty }).respond(user),
        )
      ).code,
    ).toBe("cli.no_result");
    const err = join(dir, "err");
    writeFileSync(err, '{"type":"result","is_error":true,"result":"boom"}\n');
    const e = await failure(
      target("claude", ECHO, { FAKE_STDOUT: err }).respond(user),
    );
    expect([e.code, e.detail]).toEqual(["cli.agent_error", "boom"]);
  });

  test("a missing binary is not_found and non-retryable", async () => {
    const t = new CodingAgentTarget("claude", {
      env: { PATH: join(dir, "empty") },
    });
    targets.push(t);
    const e = await failure(t.respond(user));
    expect(e.code).toBe("cli.not_found");
    expect(e).toBeInstanceOf(NonRetryableTargetError);
    expect(e).toBeInstanceOf(CodingAgentError);
    expect(e).toBeInstanceOf(CodingAgentUnavailableError);
  });

  test("caller env overlays the host env", async () => {
    const t = target(
      "claude",
      `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "seen"))}, process.env.EVQ_TEST_VALUE ?? "");`,
      { EVQ_TEST_VALUE: "caller" },
    );
    process.env.EVQ_TEST_VALUE = "host";
    try {
      await failure(t.respond(user));
    } finally {
      delete process.env.EVQ_TEST_VALUE;
    }
    expect(readFileSync(join(dir, "seen"), "utf8")).toBe("caller");
  });

  test("the prompt goes to stdin and the system prompt to claude's flag", async () => {
    const t = target(
      "claude",
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "seen"))}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));`,
      {},
      { systemPrompt: "be terse" },
    );
    await failure(t.respond(user));
    const seen = JSON.parse(readFileSync(join(dir, "seen"), "utf8"));
    expect(seen.argv.slice(-2)).toEqual(["--append-system-prompt", "be terse"]);
    expect(seen.stdin).toContain(
      '<conversation>[{"role": "user", "content": "hi"}]</conversation>',
    );
  });

  test("a permission denial survives as an incomplete tool call", async () => {
    const r = await target("claude", ECHO, {
      FAKE_STDOUT: fixture("claude_denied"),
    }).respond(user);
    expect(r.output.at(-1)?.type).toBe("output_text");
  });
});

describe("limits and cancellation", () => {
  test("silence past the idle limit kills the process group", async () => {
    const pidfile = join(dir, "pid");
    const t = target(
      "claude",
      SLEEPER,
      { FAKE_PIDFILE: pidfile },
      { timeoutMs: 400 },
    );
    const e = await failure(t.respond(user));
    expect([e.code, e.killReason]).toEqual(["cli.timeout", "idle_timeout"]);
    expect(e.detail).toMatch(
      /^no output for 0s \(last event: none at \d\d:\d\d:\d\d\)$/,
    );
    const pid = Number(readFileSync(pidfile, "utf8"));
    await waitFor(() => !pidAlive(pid));
    expect(e).toBeInstanceOf(NonRetryableTargetError);
  });

  test("steady output outlives the idle limit", async () => {
    const r = await target(
      "claude",
      `${PRINT_LOOP(40, 35, "stdout", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(fixture("claude_tool"))}));`)}`,
      {},
      { timeoutMs: 1000 },
    ).respond(user);
    expect(r.output.at(-1)).toMatchObject({ text: "done" });
  });

  test("sustained stderr resets the idle limit", async () => {
    const e = await failure(
      target(
        "claude",
        PRINT_LOOP(40, 35, "stderr", "process.exit(0);"),
        {},
        { timeoutMs: 1000 },
      ).respond(user),
    );
    expect(e.code).toBe("cli.no_result");
  });

  test("the hard cap fires on steady output", async () => {
    const e = await failure(
      target(
        "claude",
        PRINT_LOOP(30, 1000),
        {},
        { timeoutMs: 300, maxTurnMs: 400 },
      ).respond(user),
    );
    expect([e.code, e.killReason]).toEqual(["cli.timeout", "hard_cap"]);
    expect(e.detail).toMatch(/^turn exceeded 0s \(\d+ events\)$/);
  });

  test("a child holding stdout open after the agent exits still hits the idle limit", async () => {
    const e = await failure(
      target(
        "claude",
        `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "ignore"] }).unref();`,
        {},
        { timeoutMs: 300 },
      ).respond(user),
    );
    expect(e.killReason).toBe("idle_timeout");
  });

  test("abort kills the process group and logs cancelled", async () => {
    const pidfile = join(dir, "pid");
    const t = target("claude", SLEEPER, { FAKE_PIDFILE: pidfile });
    const controller = new AbortController();
    const pending = failure(t.respond(user, { signal: controller.signal }));
    await waitFor(() => existsSync(pidfile));
    controller.abort();
    const e = await pending;
    expect((e as unknown as Error).name).toBe("AbortError");
    await waitFor(() => !pidAlive(Number(readFileSync(pidfile, "utf8"))));
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).includes("cancelled: the caller cancelled"),
      ),
    ).toBe(true);
  });

  test("limits must fit finite positive timers and the target manages its own timeout", () => {
    for (const key of ["timeoutMs", "maxTurnMs"] as const)
      for (const value of [0, -1, Number.NaN, Infinity, -Infinity, 2147483648])
        expect(() => new CodingAgentTarget("claude", { [key]: value })).toThrow(
          "timeoutMs and maxTurnMs must be finite numbers greater than 0 and at most 2147483647",
        );
    expect(
      new CodingAgentTarget("claude", { timeoutMs: 0.5, maxTurnMs: 2147483647 })
        .managesOwnTimeout,
    ).toBe(true);
    expect(new CodingAgentTarget("claude").managesOwnTimeout).toBe(true);
  });
});

describe("workdir and configuration", () => {
  test("the workdir is lazy, then copied per clone", async () => {
    const source = join(dir, "src");
    mkdirSync(source);
    writeFileSync(join(source, "a.txt"), "x");
    const t = target(
      "claude",
      ECHO,
      { FAKE_STDOUT: fixture("claude_tool") },
      { workdir: source },
    );
    expect(t.workdir).toBeNull();
    await t.respond(user);
    const clone = t.newInstance();
    targets.push(clone);
    await clone.respond(user);
    expect(t.workdir).not.toBe(clone.workdir);
    expect(readFileSync(join(t.workdir as string, "a.txt"), "utf8")).toBe("x");
    expect(readFileSync(join(clone.workdir as string, "a.txt"), "utf8")).toBe(
      "x",
    );
  });

  test("skills are symlinked into the agent dir and listed in the context", async () => {
    const skill = join(dir, "my-skill");
    mkdirSync(skill);
    const t = target(
      "claude",
      ECHO,
      { FAKE_STDOUT: fixture("claude_tool") },
      { skills: [skill] },
    );
    await t.respond(user);
    const link = join(t.workdir as string, ".claude/skills/my-skill");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(skill);
    const context = await t.getAgentContext();
    expect(context.key).toBe("coding-agent:claude");
    expect(context.tools.at(-1)).toMatchObject({
      name: "my-skill",
      actionType: "skill",
    });
  });

  test("a skill name collision raises", async () => {
    const source = join(dir, "src");
    mkdirSync(join(source, ".claude/skills/dup"), { recursive: true });
    const skill = join(dir, "dup");
    mkdirSync(skill);
    const t = target("claude", ECHO, {}, { workdir: source, skills: [skill] });
    await expect(t.respond(user)).rejects.toThrow("skill 'dup' already exists");
  });

  test("a symlinked skills dir leaving the copy is rejected and the root removed", async () => {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    const source = join(dir, "src");
    mkdirSync(join(source, ".claude"), { recursive: true });
    symlinkSync(outside, join(source, ".claude/skills"));
    const t = target(
      "claude",
      ECHO,
      {},
      { workdir: source, skills: [join(dir, "s")] },
    );
    await expect(t.respond(user)).rejects.toThrow(
      "is a symlink that leaves the private copy",
    );
    expect(t.workdir).toBeNull();
  });

  test("close removes the workdir and is idempotent; keepWorkdir retains it", async () => {
    const t = target("claude", ECHO, { FAKE_STDOUT: fixture("claude_tool") });
    await t.respond(user);
    const path = t.workdir as string;
    await t.close();
    await t.close();
    expect(existsSync(path)).toBe(false);
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    const kept = target(
      "claude",
      ECHO,
      { FAKE_STDOUT: fixture("claude_tool") },
      { keepWorkdir: true },
    );
    await kept.respond(user);
    const keptPath = kept.workdir as string;
    await kept.close();
    expect(existsSync(keptPath)).toBe(true);
    stderr.mockRestore();
  });

  test("construction checks", () => {
    expect(
      () => new CodingAgentTarget("opencode", { permissionMode: "plan" }),
    ).toThrow("opencode has no permission-mode flag");
    expect(() => new CodingAgentTarget("nope" as never)).toThrow(
      "Unknown coding agent 'nope'",
    );
    new CodingAgentTarget("claude", { orq: { mcp: false } });
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'orq options given but launcher is "direct"',
    );
    new CodingAgentTarget("codex", { systemPrompt: "x" });
    expect(String(warn.mock.calls[1]?.[0])).toContain(
      "prepending system_prompt",
    );
  });

  test("mapError reports cli codes only", () => {
    const t = new CodingAgentTarget("claude");
    expect(t.mapError(new CodingAgentError("cli.exit.1", "boom"))).toEqual({
      code: "cli.exit.1",
      message: "boom",
    });
    expect(
      t.mapError(new CodingAgentUnavailableError("cli.timeout", "slow")),
    ).toEqual({
      code: "cli.timeout",
      message: "slow",
    });
    expect(t.mapError(new Error("other"))).toBeNull();
  });

  test("privilege escalation opt-in warns about root", () => {
    new CodingAgentTarget("claude", {
      container: { allowPrivilegeEscalation: true },
    });
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "allow_privilege_escalation=True",
    );
  });

  test("container mode reapplies implicit agent defaults on clones", () => {
    const t = new CodingAgentTarget("opencode", { container: {} });
    const clone = t.newInstance();
    for (const x of [t, clone])
      expect((x as unknown as { extraArgs: string[] }).extraArgs).toEqual([
        "--auto",
      ]);
  });
});

describe("windows batch launchers", () => {
  for (const arg of [
    'a"b',
    "50%",
    "a&b",
    "a|b",
    "<x",
    "x>",
    "a^b",
    "hi!",
    "a\nb",
  ])
    test(`refuses ${JSON.stringify(arg)}`, () => {
      codingAgentRuntime.platform = () => "win32";
      expect(() => refuseUnsafeBatchArgs(["C:\\bin\\claude.cmd", arg])).toThrow(
        CodingAgentUnavailableError,
      );
    });

  test("a .cmd suffix is an ordinary program off Windows", () => {
    codingAgentRuntime.platform = () => "linux";
    expect(() => refuseUnsafeBatchArgs(["claude.cmd", "a&b"])).not.toThrow();
  });

  test("orq's batch launcher points at the native release", () => {
    codingAgentRuntime.platform = () => "win32";
    expect(() => refuseUnsafeBatchArgs(["C:\\bin\\orq.cmd", "a&b"])).toThrow(
      "orq-win32-x64.exe",
    );
  });

  test("a batch launcher moves the system prompt into stdin", async () => {
    const bin = join(dir, "bin");
    const fake = installFake(
      bin,
      "claude",
      `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(join(dir, "seen"))}, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }));`,
    );
    codingAgentRuntime.which = () => `${fake}.cmd`;
    codingAgentRuntime.platform = () => "win32";
    const t = new CodingAgentTarget("claude", { systemPrompt: "be terse" });
    targets.push(t);
    let argv: string[] = [];
    const run = (
      t as unknown as {
        run: (a: string[], ...rest: unknown[]) => Promise<unknown>;
      }
    ).run;
    (t as unknown as { run: unknown }).run = (
      a: string[],
      ...rest: unknown[]
    ) => {
      argv = a;
      codingAgentRuntime.platform = () => "linux";
      return run.call(t, [fake, ...a.slice(1)], ...rest);
    };
    await failure(t.respond(user));
    expect(argv).not.toContain("--append-system-prompt");
    const seen = JSON.parse(readFileSync(join(dir, "seen"), "utf8"));
    expect(seen.stdin).toContain('{"role": "system", "content": "be terse"}');
  });
});

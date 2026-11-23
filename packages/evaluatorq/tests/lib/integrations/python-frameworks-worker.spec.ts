import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CrewAITarget } from "../../../src/lib/integrations/python-frameworks/index.js";

test("the real worker imports a cwd or file factory without exposing app stdout on its wire", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-worker-import-"));
  const modules = join(root, "modules");
  const project = join(root, "project");
  const targets: CrewAITarget[] = [];
  try {
    await mkdir(project);
    await mkdir(
      join(modules, "evaluatorq", "integrations", "crewai_integration"),
      { recursive: true },
    );
    for (const path of [
      "evaluatorq/__init__.py",
      "evaluatorq/integrations/__init__.py",
    ])
      await writeFile(join(modules, path), "");
    await writeFile(
      join(modules, "crewai.py"),
      `import os
print("SDK import stdout")
os.write(1, b"SDK raw fd stdout\\n")
`,
    );
    await writeFile(
      join(modules, "evaluatorq", "contracts.py"),
      `from types import SimpleNamespace
class Message:
    @staticmethod
    def model_validate(value): return SimpleNamespace(**value)
class AgentContext:
    @staticmethod
    def model_validate(value): return SimpleNamespace(**value)
`,
    );
    await writeFile(
      join(
        modules,
        "evaluatorq",
        "integrations",
        "crewai_integration",
        "__init__.py",
      ),
      `from enum import Enum
class History(str, Enum):
    CALLER = "caller"
class Wire:
    def __init__(self, value): self.value = value
    def model_dump(self, mode): return self.value
class CrewAITarget:
    history_mode = History.CALLER
    def __init__(self, crew, **options):
        self.crew = crew
        self.options = options
    def mint_memory_entity_id(self, value): self.memory_entity_id = value
    async def get_agent_context(self): return Wire({"key": "native_fixture", "display_name": "Native fixture"})
    async def respond(self, messages):
        return Wire({"output": [{"type": "output_text", "text": self.crew.kickoff(messages), "annotations": []}]})
`,
    );
    const factory = `import os, threading
from types import SimpleNamespace
print("Factory import stdout")
os.write(1, b"Factory import fd stdout\\n")
class BrokenDump:
    def model_dump(self, mode): raise ValueError("usage dump failed")
class InvalidDump:
    def model_dump(self, mode): return {"input_tokens": object()}
class ValidDump:
    def model_dump(self, mode): return {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3, "calls": 1}
class BrokenUsageError(RuntimeError):
    @property
    def usage(self): raise ValueError("usage accessor failed")
class Crew:
    def __init__(self): self.count = 0
    def kickoff(self, messages):
        content = messages[-1].content
        if content.startswith("usage:"):
            kind = content.split(":", 1)[1]
            error = BrokenUsageError("original provider failure") if kind == "accessor" else RuntimeError("original provider failure")
            error.status_code = 429
            if kind != "accessor":
                usage = {
                    "object": object(),
                    "nested-object": {"input_tokens": object()},
                    "nan": {"input_tokens": float("nan")},
                    "infinity": {"total_cost": float("inf")},
                    "dump-error": BrokenDump(),
                    "invalid-dump": InvalidDump(),
                    "valid-dump": ValidDump(),
                    "valid": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3, "calls": 1},
                }.get(kind)
                if kind == "cycle":
                    usage = {}
                    usage["self"] = usage
                elif kind == "oversize":
                    usage = {"detail": "x" * (16 * 1024 * 1024)}
                error.usage = usage
            raise error
        if content.startswith("wrapped:"):
            _, status, chain = content.split(":")
            try:
                error = RuntimeError("provider failed")
                error.response = SimpleNamespace(status_code=int(status))
                error.status_code = 500
                raise error
            except RuntimeError as error:
                if chain == "cause":
                    raise RuntimeError("wrapped failure") from error
                raise RuntimeError("wrapped failure")
        self.count += 1
        print("Crew stdout")
        thread = threading.Thread(target=lambda: os.write(1, b"Crew thread fd stdout\\n"))
        thread.start()
        thread.join()
        return str(self.count) + ":" + messages[-1].content
async def make_agent():
    print("Factory constructor stdout")
    return Crew()
`;
    await writeFile(join(project, "my_agent.py"), factory);
    const executable = join(root, "python-fixture");
    await writeFile(
      executable,
      `#!/usr/bin/env python3
import runpy, sys
sys.path.insert(0, ${JSON.stringify(modules)})
runpy.run_path(sys.argv[-1], run_name="__main__")
`,
    );
    await chmod(executable, 0o700);
    for (const locator of [
      "my_agent:make_agent",
      `${join(project, "my_agent.py")}:make_agent`,
    ]) {
      const target = new CrewAITarget({
        factory: locator,
        pythonExecutable: executable,
        cwd: project,
        timeoutMs: 2000,
      });
      targets.push(target);
      expect((await target.getAgentContext()).displayName).toBe(
        "Native fixture",
      );
      expect(
        (await target.respond([{ role: "user", content: "héllo" }])).text,
      ).toBe("1:héllo");
      expect(
        (await target.respond([{ role: "user", content: "again" }])).text,
      ).toBe("2:again");
      for (const status of [400, 401, 403, 429])
        for (const chain of ["cause", "context"])
          await expect(
            target.respond([
              { role: "user", content: `wrapped:${status}:${chain}` },
            ]),
          ).rejects.toMatchObject({ status });
      let turns = 2;
      for (const kind of [
        "object",
        "nested-object",
        "cycle",
        "nan",
        "infinity",
        "dump-error",
        "invalid-dump",
        "accessor",
        "oversize",
      ]) {
        const failure = await target
          .respond([{ role: "user", content: `usage:${kind}` }])
          .then(
            () => {
              throw new Error("Expected a provider error");
            },
            (error: unknown) => error,
          );
        expect(failure).toMatchObject({
          status: 429,
          message: `crewai: ${kind === "accessor" ? "BrokenUsageError" : "RuntimeError"}: original provider failure`,
        });
        expect(failure).not.toHaveProperty("usage");
        expect(
          (await target.respond([{ role: "user", content: "healthy" }])).text,
        ).toBe(`${++turns}:healthy`);
      }
      for (const kind of ["valid", "valid-dump"])
        await expect(
          target.respond([{ role: "user", content: `usage:${kind}` }]),
        ).rejects.toMatchObject({
          status: 429,
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, calls: 1 },
        });
    }
  } finally {
    await Promise.all(targets.map((target) => target.close()));
    await rm(root, { recursive: true, force: true });
  }
});

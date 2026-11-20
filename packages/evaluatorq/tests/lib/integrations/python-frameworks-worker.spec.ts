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
print("Factory import stdout")
os.write(1, b"Factory import fd stdout\\n")
class Crew:
    def __init__(self): self.count = 0
    def kickoff(self, messages):
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
    }
  } finally {
    await Promise.all(targets.map((target) => target.close()));
    await rm(root, { recursive: true, force: true });
  }
});

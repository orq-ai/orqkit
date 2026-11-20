import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileLock } from "../../../src/lib/common/file-lock.js";

test("recovers old incomplete locks and publishes a complete owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-"));
  try {
    for (const content of ["", "not-a-pid", "999999999999999999999999"]) {
      const path = join(root, "state");
      await writeFile(`${path}.held`, content);
      const old = new Date(Date.now() - 30000);
      await utimes(`${path}.held`, old, old);
      await withFileLock(path, async () => {
        const owner = JSON.parse(await readFile(`${path}.held`, "utf8"));
        expect(owner.pid).toBe(process.pid);
        expect(typeof owner.token).toBe("string");
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps a live owner and serializes concurrent writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-"));
  const path = join(root, "state");
  let entered = false;
  try {
    await writeFile(`${path}.held`, String(process.pid));
    const waiting = withFileLock(path, async () => {
      entered = true;
    });
    await Bun.sleep(60);
    expect(entered).toBe(false);
    await rm(`${path}.held`);
    await waiting;
    let active = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withFileLock(path, async () => {
          expect(++active).toBe(1);
          await Bun.sleep(2);
          active--;
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes writers in different processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-process-"));
  const path = join(root, "counter");
  await writeFile(path, "0");
  await writeFile(`${path}.held`, "4194000");
  await mkdir(`${path}.held.takeover`);
  await writeFile(
    `${path}.held.takeover/owner-${"b".repeat(32)}.json`,
    "4194000",
  );
  const moduleUrl = new URL(
    "../../../src/lib/common/file-lock.ts",
    import.meta.url,
  ).href;
  const script = `import { withFileLock } from ${JSON.stringify(moduleUrl)};
    import {readFile, writeFile} from "node:fs/promises";
    const path = ${JSON.stringify(path)};
    for (let i=0; i<4; i++) await withFileLock(path, async () => {
      const count = Number(await readFile(path, "utf8"));
      await Bun.sleep(2);
      await writeFile(path, String(count+1));
    });`;
  const children = Array.from({ length: 3 }, () =>
    Bun.spawn([process.execPath, "--eval", script], {
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  try {
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0, 0,
    ]);
    expect(await readFile(path, "utf8")).toBe("12");
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
});

test("release preserves a replacement owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-owner-"));
  const path = join(root, "state");
  const replacement = JSON.stringify({
    pid: process.pid,
    token: "replacement",
  });
  try {
    await withFileLock(path, async () => {
      await writeFile(`${path}.held`, replacement);
    });
    expect(await readFile(`${path}.held`, "utf8")).toBe(replacement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote owners and live reused PIDs fail within the wait budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-timeout-"));
  const path = join(root, "state");
  try {
    for (const owner of [
      JSON.stringify({ pid: 4194000, host: "remote-host", token: "remote" }),
      String(process.pid),
    ]) {
      await writeFile(`${path}.held`, owner);
      await expect(
        withFileLock(
          path,
          async () => {
            throw new Error("must not enter");
          },
          { timeoutMs: 30 },
        ),
      ).rejects.toThrow("Timed out waiting");
      expect(await readFile(`${path}.held`, "utf8")).toBe(owner);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a dead owner and an abandoned legacy or directory takeover guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-guard-"));
  const path = join(root, "state");
  try {
    for (const directoryGuard of [false, true]) {
      await writeFile(`${path}.held`, "4194000");
      if (directoryGuard) {
        await mkdir(`${path}.held.takeover`);
        await writeFile(
          `${path}.held.takeover/owner-${"a".repeat(32)}.json`,
          "4194000",
        );
      } else await writeFile(`${path}.held.takeover`, "4194000");
      expect(
        await withFileLock(path, async () => "recovered", { timeoutMs: 1000 }),
      ).toBe("recovered");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued timeout does not execute later or reorder the next owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "eq-lock-queue-"));
  const path = join(root, "state");
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let late = false;
  const first = withFileLock(path, async () => {
    started();
    await gate;
  });
  await entered;
  try {
    await expect(
      withFileLock(
        path,
        async () => {
          late = true;
        },
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow("Timed out waiting");
    release();
    await first;
    expect(await withFileLock(path, async () => "next")).toBe("next");
    expect(late).toBe(false);
  } finally {
    release();
    await first;
    await rm(root, { recursive: true, force: true });
  }
});

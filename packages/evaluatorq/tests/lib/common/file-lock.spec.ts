import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
        expect(await readFile(`${path}.held`, "utf8")).toBe(
          String(process.pid),
        );
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

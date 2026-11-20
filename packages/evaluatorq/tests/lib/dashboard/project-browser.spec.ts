import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

import { listProjectDirectories } from "../../../src/lib/dashboard/project-browser.js";

const golden = (await import("./fixtures/project-browser-golden.json"))
  .default as {
  names: string[];
  order: string[];
  keys: string[];
  limit: number;
  has_more: boolean;
  offset: number;
};

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = resolve(await mkdtemp(join(tmpdir(), "eq-browser-")));
  dirs.push(dir);
  return dir;
}

const savedHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = savedHome;
});

describe("listProjectDirectories", () => {
  it("matches the Python sort order and payload keys", async () => {
    const root = await tmp();
    for (const name of golden.names) await mkdir(join(root, name));
    await writeFile(join(root, "file.txt"), "x");
    const result = await listProjectDirectories(root);
    expect(result.directories.map((d) => d.name)).toEqual(golden.order);
    expect(Object.keys(result).sort()).toEqual(golden.keys);
    expect(result.limit).toBe(golden.limit);
    expect(result.has_more).toBe(golden.has_more);
    expect(result.offset).toBe(golden.offset);
  });

  it("lists hidden and symlinked directories but not files", async () => {
    const root = await tmp();
    await mkdir(join(root, "visible"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "file.txt"), "not read");
    const target = join(root, "target");
    await mkdir(target);
    await symlink(target, join(root, "linked"), "dir");
    await symlink(join(root, "missing"), join(root, "broken"), "dir");
    const result = await listProjectDirectories(root);
    expect(result.directories.map((d) => d.name)).toEqual([
      ".hidden",
      "linked",
      "target",
      "visible",
    ]);
    expect(result.directories.find((d) => d.name === "linked")?.path).toBe(
      await realpath(target),
    );
  });

  it("separates an empty directory from a missing one", async () => {
    const root = await tmp();
    await mkdir(join(root, "empty"));
    expect(
      (await listProjectDirectories(join(root, "empty"))).directories,
    ).toEqual([]);
    await expect(listProjectDirectories(join(root, "missing"))).rejects.toThrow(
      "could not be opened",
    );
  });

  it("resolves blank and tilde paths to home", async () => {
    const root = await tmp();
    await mkdir(join(root, "child"));
    process.env.HOME = root;
    const expected = await realpath(root);
    expect((await listProjectDirectories()).path).toBe(expected);
    expect((await listProjectDirectories("~/")).path).toBe(expected);
  });

  it("builds parent and breadcrumbs from the resolved path", async () => {
    const root = await tmp();
    const nested = join(root, "one", "two");
    await mkdir(nested, { recursive: true });
    const resolved = await realpath(nested);
    const result = await listProjectDirectories(nested);
    expect(result.path).toBe(resolved);
    expect(result.parent).toBe(dirname(resolved));
    const chain = [resolved];
    while (dirname(chain[0] as string) !== chain[0])
      chain.unshift(dirname(chain[0] as string));
    expect(result.breadcrumbs).toEqual(
      chain.map((p) => ({ name: p.split("/").pop() || p, path: p })),
    );
    expect(
      (await listProjectDirectories(parse(resolved).root)).parent,
    ).toBeNull();
  });

  it("pages sorted directories without overlap", async () => {
    const root = await tmp();
    const names = Array.from(
      { length: 405 },
      (_, i) => `Project ${String(i).padStart(3, "0")}`,
    );
    for (const name of names) await mkdir(join(root, name));
    const pages = [
      await listProjectDirectories(root),
      await listProjectDirectories(root, { offset: 200 }),
      await listProjectDirectories(root, { offset: 400 }),
    ];
    expect(pages.map((p) => p.directories.length)).toEqual([200, 200, 5]);
    expect(pages.map((p) => p.has_more)).toEqual([true, true, false]);
    expect(pages.flatMap((p) => p.directories.map((d) => d.name))).toEqual(
      names,
    );
  });

  it("rejects invalid paths and offsets", async () => {
    const root = await tmp();
    await expect(listProjectDirectories("relative/path")).rejects.toThrow(
      "absolute directory path",
    );
    await writeFile(join(root, "file"), "");
    await expect(listProjectDirectories(join(root, "file"))).rejects.toThrow(
      "could not be opened",
    );
    await expect(listProjectDirectories("\0")).rejects.toThrow(
      "valid directory path",
    );
    for (const offset of [-1, true, 1.5]) {
      await expect(listProjectDirectories(root, { offset })).rejects.toThrow(
        "nonnegative integer",
      );
    }
  });

  it("keeps untrusted names as plain data", async () => {
    const root = await tmp();
    const name = "folder & 'quoted'";
    await mkdir(join(root, name));
    expect((await listProjectDirectories(root)).directories).toEqual([
      { name, path: await realpath(join(root, name)) },
    ]);
  });
});

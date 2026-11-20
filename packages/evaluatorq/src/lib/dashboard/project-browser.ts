import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";

export const DIRECTORY_PAGE_SIZE = 200;

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryPage {
  path: string;
  parent: string | null;
  breadcrumbs: DirectoryEntry[];
  directories: DirectoryEntry[];
  offset: number;
  limit: number;
  has_more: boolean;
}

function breadcrumbs(path: string): DirectoryEntry[] {
  const chain = [path];
  let current = path;
  while (dirname(current) !== current) {
    current = dirname(current);
    chain.push(current);
  }
  return chain.reverse().map((part) => {
    const name = part === parse(part).root ? "" : (part.split(sep).pop() ?? "");
    return { name: name || part, path: part };
  });
}

const home = (): string => process.env.HOME || homedir();

function expandUser(path: string): string {
  if (path === "~" || path.startsWith("~/") || path.startsWith(`~${sep}`)) {
    return join(home(), path.slice(1));
  }
  return path;
}

const casefoldKey = (a: string, b: string): number => {
  const fa = a.toLowerCase();
  const fb = b.toLowerCase();
  if (fa !== fb) return fa < fb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

export async function listProjectDirectories(
  path = "",
  { offset = 0 }: { offset?: unknown } = {},
): Promise<DirectoryPage> {
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("Directory page offset must be a nonnegative integer.");
  }
  if (typeof path !== "string" || path.includes("\0")) {
    throw new Error("Enter a valid directory path.");
  }
  const candidate = path ? expandUser(path) : home();
  if (!isAbsolute(candidate)) {
    throw new Error(
      "Enter an absolute directory path, or leave it blank to browse your home folder.",
    );
  }
  let current: string;
  try {
    current = await realpath(candidate);
    if (!(await stat(current)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    const category =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "directory_missing"
        : "directory_inaccessible";
    console.warn(`Project directory browser rejected path (${category})`);
    throw new Error(
      "That folder could not be opened. Check the path and your access, then try again.",
    );
  }

  const names: string[] = [];
  try {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        names.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(join(current, entry.name))).isDirectory()) {
            names.push(entry.name);
          }
        } catch {}
      }
    }
  } catch {
    console.warn(
      "Project directory browser could not list folder (directory_inaccessible)",
    );
    throw new Error(
      "That folder could not be listed. Check your access, then try again.",
    );
  }

  names.sort(casefoldKey);
  const directories: DirectoryEntry[] = [];
  for (const name of names.slice(offset, offset + DIRECTORY_PAGE_SIZE)) {
    try {
      directories.push({ name, path: await realpath(join(current, name)) });
    } catch {}
  }
  const parent = dirname(current);
  return {
    path: current,
    parent: parent !== current ? parent : null,
    breadcrumbs: breadcrumbs(current),
    directories,
    offset,
    limit: DIRECTORY_PAGE_SIZE,
    has_more: offset + DIRECTORY_PAGE_SIZE < names.length,
  };
}

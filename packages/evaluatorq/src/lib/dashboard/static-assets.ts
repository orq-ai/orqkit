import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// src/lib/dashboard and dist/lib/dashboard both sit three levels below the package root.
export const STATIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "static",
);

const versions = new Map<string, string>();

export function assetVersion(filename: string): string {
  let version = versions.get(filename);
  if (version === undefined) {
    version = createHash("sha256")
      .update(readFileSync(join(STATIC_DIR, filename)))
      .digest("hex")
      .slice(0, 12);
    versions.set(filename, version);
  }
  return version;
}

const assetUrl = (filename: string) =>
  `/static/${filename}?v=${assetVersion(filename)}`;

export const stylesheetAsset = (filename: string) =>
  `<link rel="stylesheet" href="${assetUrl(filename)}">\n`;

export const scriptAsset = (filename: string) =>
  `<script src="${assetUrl(filename)}" defer></script>\n`;

export const componentAssets = () =>
  stylesheetAsset("ui-components.css") + scriptAsset("ui-components.js");

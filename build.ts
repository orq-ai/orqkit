#!/usr/bin/env bun

import { $, Glob } from 'bun';
import { promises as fs } from 'fs';
import path from 'path';

const packages = ['shared', 'evaluators', 'core', 'orq-integration', 'cli'];

async function buildPackage(pkg: string) {
  console.log(`Building @evaluatorq/${pkg}...`);
  
  const srcDir = path.join('packages', pkg, 'src');
  const distDir = path.join('packages', pkg, 'dist');
  
  // Clean dist directory
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distDir, { recursive: true });
  
  // Use tsc to compile
  await $`cd packages/${pkg} && tsc --project tsconfig.lib.json`;
  
  console.log(`✓ Built @evaluatorq/${pkg}`);
}

async function main() {
  for (const pkg of packages) {
    try {
      await buildPackage(pkg);
    } catch (error) {
      console.error(`Failed to build ${pkg}:`, error);
    }
  }
}

main().catch(console.error);
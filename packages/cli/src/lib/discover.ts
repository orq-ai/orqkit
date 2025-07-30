import { Effect, pipe } from 'effect';
import { Glob } from 'bun';
import path from 'path';
import { promises as fs } from 'fs';

export interface EvalFile {
  path: string;
  name: string;
  relativePath: string;
}

export const discoverEvalFiles = (
  rootDir: string = process.cwd(),
  pattern: string = '**/*.eval.ts',
): Effect.Effect<EvalFile[]> =>
  Effect.gen(function* () {
    const glob = new Glob(pattern);
    const files: EvalFile[] = [];
    
    for await (const file of glob.scan({ cwd: rootDir })) {
      // Skip node_modules and other common directories
      if (
        file.includes('node_modules') ||
        file.includes('.git') ||
        file.includes('dist') ||
        file.includes('build')
      ) {
        continue;
      }
      
      const fullPath = path.resolve(rootDir, file);
      const name = path.basename(file, '.eval.ts');
      
      files.push({
        path: fullPath,
        name,
        relativePath: file,
      });
    }
    
    return files;
  });

export const loadEvalFile = (
  filePath: string,
): Effect.Effect<any, Error> =>
  Effect.tryPromise({
    try: async () => {
      // Clear module cache to ensure fresh imports
      delete require.cache[filePath];
      
      // Use dynamic import to load the file
      const module = await import(filePath);
      return module;
    },
    catch: (error) => new Error(`Failed to load eval file: ${String(error)}`),
  });

export const runEvalFile = (
  evalFile: EvalFile,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    console.log(`\n📊 Running: ${evalFile.relativePath}`);
    
    try {
      // Import and execute the eval file
      await import(evalFile.path);
      console.log(`✓ Completed: ${evalFile.name}`);
    } catch (error) {
      console.error(`✗ Failed: ${evalFile.name}`);
      throw error;
    }
  });
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type SpawnResult = Promise<number | null>;

type FileCollector = (dir: string) => string[];

type WalkFn = (dir: string, results: string[]) => void;

const ROOT = process.cwd();

const collectTests: FileCollector = (dir) => {
  const absoluteDir = path.resolve(ROOT, dir);
  const results: string[] = [];

  const walk: WalkFn = (current, accumulator) => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(resolved, accumulator);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        accumulator.push(path.relative(ROOT, resolved));
      }
    }
  };

  try {
    const stats = statSync(absoluteDir);
    if (stats.isDirectory()) {
      walk(absoluteDir, results);
    }
  } catch (error) {
    console.error(`Unable to read test directory '${dir}':`, error);
    process.exitCode = 1;
  }

  return results;
};

const testFiles = collectTests("src");

if (testFiles.length === 0) {
  console.warn("No test files found matching '*.test.ts'.");
  process.exit(0);
}

const runTests = (files: string[]): SpawnResult => {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
      stdio: "inherit",
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(null);
        return;
      }

      resolve(code);
    });
  });
};

runTests(testFiles).then((code) => {
  process.exit(code ?? 0);
});

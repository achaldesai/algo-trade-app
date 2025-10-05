import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const collectTests = (dir) => {
  const absoluteDir = path.resolve(ROOT, dir);
  const results = [];

  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(resolved);
      } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        results.push(path.relative(ROOT, resolved));
      }
    }
  };

  try {
    const stats = statSync(absoluteDir);
    if (stats.isDirectory()) {
      walk(absoluteDir);
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

const args = ["--import", "tsx", "--test", ...testFiles];

const child = spawn(process.execPath, args, { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

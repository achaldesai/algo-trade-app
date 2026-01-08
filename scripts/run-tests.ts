import { spawn } from "node:child_process";
import { readdirSync, statSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

type SpawnResult = Promise<number | null>;

type FileCollector = (dir: string) => string[];

type WalkFn = (dir: string, results: string[]) => void;

const ROOT = process.cwd();

const TEST_STORE_PATH = path.resolve(ROOT, "data/portfolio-store.test.json");

// Force 'file' backend for tests to avoid LMDB/JSON path conflicts
process.env.PORTFOLIO_BACKEND = "file";

if (!process.env.PORTFOLIO_STORE) {
  process.env.PORTFOLIO_STORE = TEST_STORE_PATH;
}

// Clean up existing test data to prevent EEXIST conflicts
if (existsSync(TEST_STORE_PATH)) {
    console.log(`Cleaning up existing test data at ${TEST_STORE_PATH}...`);
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

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

const loadPersistence = async () => {
  const mod = await import("../src/persistence/index.ts");
  const exports = (mod as { default?: unknown }).default as Record<string, unknown> | undefined;
  const ensurePortfolioStore = (exports?.ensurePortfolioStore ?? (mod as Record<string, unknown>).ensurePortfolioStore) as () => Promise<void>;
  const resetPortfolioStore = (exports?.resetPortfolioStore ?? (mod as Record<string, unknown>).resetPortfolioStore) as () => Promise<void>;
  return { ensurePortfolioStore, resetPortfolioStore };
};

const testFiles = collectTests("src");

if (testFiles.length === 0) {
  console.warn("No test files found matching '*.test.ts'.");
  process.exit(0);
}

const runTestFile = (file: string): SpawnResult =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--test", file], {
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

const runTests = async (files: string[]): Promise<number | null> => {
  const { ensurePortfolioStore, resetPortfolioStore } = await loadPersistence();
  for (const file of files) {
    await ensurePortfolioStore();
    await resetPortfolioStore();
    const code = await runTestFile(file);
    if (code === null) {
      return null;
    }
    if (code !== 0) {
      return code;
    }
  }

  return 0;
};

const main = async () => {
  const { ensurePortfolioStore, resetPortfolioStore } = await loadPersistence();
  await ensurePortfolioStore();
  await resetPortfolioStore();

  const code = await runTests(testFiles);

  process.exit(code ?? 0);
};

main().catch((error) => {
  console.error("Failed to run tests", error);
  process.exit(1);
});

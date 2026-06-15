import { test } from "bun:test";
import { walk, WALK_DEPTH_COUNT, MIN_WALK_DATA_SIZE_MB } from "../walk";
import path from "node:path";

test("walk benchmark over a medium system path", async () => {
  // "medium decent size path on the system"
  // Default is ~/Library/Caches on macOS (realistic medium/heavy path).
  // Override with: WALK_BENCH_PATH=/some/path bun test
  const defaultPath = process.env.HOME
    ? path.join(process.env.HOME, "Library", "Caches")
    : "/tmp";

  const benchPath = process.env.WALK_BENCH_PATH ?? defaultPath;

  console.log("\nwalk benchmark\n");
  console.log(`Path=${benchPath}`);
  console.log(`Effective constants (env-overridable):`);
  console.log(`  WALK_DEPTH_COUNT=${WALK_DEPTH_COUNT}`);
  console.log(`  MIN_WALK_DATA_SIZE_MB=${MIN_WALK_DATA_SIZE_MB} (set MIN_WALK_DATA_SIZE_MB=xx to change)`);

  const start = performance.now();

  const results = await walk(benchPath);

  const durationMs = performance.now() - start;

  console.log(`\nTime=${durationMs.toFixed(2)} ms`);
  console.log(`Results returned=${results.length}`);

  if (results.length > 0) {
    const top = results[0];
    const sizeMB = (top.size / 1024 / 1024).toFixed(1);
    console.log(`Largest: ${sizeMB} MB -> ${top.path}`);
    console.log(`Top 3 paths:`);
    results.slice(0, 3).forEach((r, i) => {
      const mb = (r.size / 1024 / 1024).toFixed(1);
      console.log(`  ${i + 1}. ${mb} MB  ${r.path}`);
    });
  } else {
    console.log("(no folders met the current size + depth criteria)");
  }

  if (!Array.isArray(results)) {
    throw new Error("walk() must return an array");
  }
}, 30000); // generous timeout for real filesystem benchmarks

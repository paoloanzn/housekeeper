import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import type { Heavy, SubtreeResult, WalkCtx } from "./walk-darwin";

const CONCURRENCY    = Number(Bun.env.WALK_CONCURRENCY ?? 48); // portable path: overlap I/O on the libuv pool
const WORKER_COUNT   = Number(Bun.env.WALK_WORKERS ?? 4);      // macOS path: ~P-core count is the sweet spot
const MIN_SUBDIRS_PAR = 8; // below this, a single thread beats worker startup cost

// Worker startup is cheap under `bun run`/`bun test`, but inside a `bun build
// --compile` standalone binary each Worker re-bootstraps the embedded runtime
// (~0.5s each) — there we stay single-threaded. Standalone modules live in /$bunfs.
const WORKERS_FAST = !import.meta.dir.startsWith("/$bunfs");

let _defaultExclude: string[] = [
  "/System",
  "/private/var/vm",
  "/private/var/db",
  "/dev",
  "/cores",
  "/net",
  "/.vol",
  "/.fseventsd",
  "/.Spotlight-V100",
  "/.DocumentRevisions-V100",
  "/.Trashes",
];

if (Bun.env.DEFAULT_WALK_EXCLUDE) {
  const parsed = Bun.env.DEFAULT_WALK_EXCLUDE
    .split(/[,;:|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parsed.length > 0) {
    _defaultExclude = parsed;
  }
}

export const DEFAULT_WALK_EXCLUDE: string[] = _defaultExclude;
export const WALK_DEPTH_COUNT               = Number(Bun.env.WALK_DEPTH_COUNT ?? 4);
export const MIN_WALK_DATA_SIZE_MB          = Number(Bun.env.MIN_WALK_DATA_SIZE_MB ?? 500);

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return val.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

/** Excludes that still apply when walking `root` (a root under an exclude wins). */
function makeCtx(root: string): WalkCtx {
  const excludes = DEFAULT_WALK_EXCLUDE
    .map((ex) => path.resolve(ex))
    .filter((ex) => !(root === ex || root.startsWith(ex + path.sep)));
  return {
    excludes,
    minSize: MIN_WALK_DATA_SIZE_MB * 1024 * 1024,
    maxDepth: WALK_DEPTH_COUNT,
  };
}

type RootAgg = { size: number; depthBeneath: number; heavies: Heavy[] };

/** Fold one finished subtree's size/depth into the running root totals. */
function foldSizeDepth(agg: RootAgg, r: SubtreeResult): void {
  agg.size += r.size;
  if (r.depthBeneath + 1 > agg.depthBeneath) agg.depthBeneath = r.depthBeneath + 1;
}

/**
 * Distribute subtrees across a worker pool, dynamically (handles skewed trees).
 * Resolves null if a worker fails to start (e.g. the worker module isn't
 * embedded in a standalone binary) so the caller can fall back to one thread.
 */
function runWorkers(subdirs: string[], ctx: WalkCtx): Promise<SubtreeResult[] | null> {
  const count = Math.min(subdirs.length, WORKER_COUNT);
  const workers = Array.from(
    { length: count },
    () => new Worker(new URL("./walk.worker.ts", import.meta.url)),
  );
  const results: SubtreeResult[] = [];
  let next = 0;
  let outstanding = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (value: SubtreeResult[] | null) => {
      if (settled) return;
      settled = true;
      for (const w of workers) w.terminate();
      resolve(value);
    };
    const pump = (w: Worker) => {
      if (next < subdirs.length) {
        outstanding++;
        w.postMessage({ dir: subdirs[next++], ctx });
      } else {
        w.terminate();
      }
    };
    for (const w of workers) {
      w.onerror = () => finish(null);
      w.onmessage = (e: MessageEvent<SubtreeResult>) => {
        results.push(e.data);
        outstanding--;
        pump(w);
        if (outstanding === 0 && next >= subdirs.length) finish(results);
      };
      pump(w);
    }
  });
}

async function walkDarwin(root: string): Promise<Heavy[]> {
  const { listChildren, walkSubtree } = await import("./walk-darwin");
  const ctx = makeCtx(root);

  const { subdirs, fileSize, sawLeaf } = listChildren(root);
  const agg: RootAgg = {
    size: fileSize,
    depthBeneath: subdirs.length > 0 || sawLeaf ? 1 : 0,
    heavies: [],
  };

  const useWorkers = WORKERS_FAST && subdirs.length >= MIN_SUBDIRS_PAR;
  const parallel = useWorkers ? await runWorkers(subdirs, ctx) : null;

  if (parallel) {
    // Workers return their own heavies arrays (over postMessage); collect them.
    for (const r of parallel) {
      for (const h of r.heavies) agg.heavies.push(h);
      foldSizeDepth(agg, r);
    }
  } else {
    // Small tree, or workers unavailable: walkSubtree appends into agg.heavies.
    for (const sub of subdirs) {
      foldSizeDepth(agg, walkSubtree(sub, ctx, agg.heavies));
    }
  }

  if (agg.depthBeneath <= ctx.maxDepth && agg.size >= ctx.minSize) {
    agg.heavies.push({ path: root, size: agg.size });
  }

  agg.heavies.sort((a, b) => b.size - a.size);
  return agg.heavies;
}

/** Portable fallback: async readdir + per-file stat (used off macOS). */
async function walkPortable(root: string): Promise<Heavy[]> {
  const ctx = makeCtx(root);
  const heavies: Heavy[] = [];

  function excluded(dir: string): boolean {
    for (const ex of ctx.excludes) {
      if (dir === ex || dir.startsWith(ex + path.sep)) return true;
    }
    return false;
  }

  async function recurse(dir: string): Promise<{ size: number; depthBeneath: number }> {
    if (excluded(dir)) return { size: 0, depthBeneath: 0 };

    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return { size: 0, depthBeneath: 0 };
    }

    const makeChild = (name: string) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
    const work: Array<() => Promise<{ size: number; depthBeneath: number }>> = [];

    for (const dirent of dirents) {
      const child = makeChild(dirent.name);
      if (dirent.isSymbolicLink()) {
        work.push(async () => {
          try { return { size: (await lstat(child)).size, depthBeneath: 0 }; }
          catch { return { size: 0, depthBeneath: 0 }; }
        });
      } else if (dirent.isDirectory()) {
        work.push(() => recurse(child));
      } else if (dirent.isFile()) {
        work.push(async () => {
          try { return { size: await Bun.file(child).size, depthBeneath: 0 }; }
          catch { return { size: 0, depthBeneath: 0 }; }
        });
      }
    }

    let total = 0;
    let maxBeneath = 0;
    for (let i = 0; i < work.length; i += CONCURRENCY) {
      const results = await Promise.all(work.slice(i, i + CONCURRENCY).map((w) => w()));
      for (const res of results) {
        total += res.size;
        if (res.depthBeneath + 1 > maxBeneath) maxBeneath = res.depthBeneath + 1;
      }
    }

    if (maxBeneath <= ctx.maxDepth && total >= ctx.minSize) {
      heavies.push({ path: dir, size: total });
    }
    return { size: total, depthBeneath: maxBeneath };
  }

  await recurse(root);
  heavies.sort((a, b) => b.size - a.size);
  return heavies;
}

export async function walk(entrypoint: string): Promise<Heavy[]> {
  const root = path.resolve(entrypoint);
  if (process.platform === "darwin") return walkDarwin(root);
  return walkPortable(root);
}

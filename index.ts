#!/usr/bin/env bun

import { parseArgs } from "node:util";
import { readdir, stat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { walk, formatBytes, WALK_DEPTH_COUNT, MIN_WALK_DATA_SIZE_MB } from "./walk";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    "no-zip": { type: "boolean" },
  },
  strict: false,
  allowPositionals: true,
});

const pkg = await import("./package.json", { with: { type: "json" } });

if (values.version) {
  console.log(pkg.default.version);
  process.exit(0);
}

const command = positionals[0];

if (values.help || !command) {
  console.log(`housekeeper - minimal Bun CLI

Usage:
  housekeeper <command> [options]
  hsk <command> [options]

Commands:
  compact  Reorganize old top-level files/dirs in <path> into weekly folders (zips by default; use --no-zip to keep folders)
  walk     Walk entrypoint recursively and list heavy folders (≥ MIN_WALK_DATA_SIZE_MB, subtree depth ≤ WALK_DEPTH_COUNT)
  help     Show this help message

Options:
  -h, --help     Show help
  -v, --version  Show version
`);
  process.exit(0);
}

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(process.env.HOME || process.env.USERPROFILE || "", p.slice(1));
  }
  return p;
}

function mondayOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const delta = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + delta);
  return x;
}

function makeArchiveName(weekStart: Date): string {
  const y = weekStart.getFullYear();
  const m = String(weekStart.getMonth() + 1).padStart(2, "0");
  const d1 = String(weekStart.getDate()).padStart(2, "0");
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  const d2 = String(end.getDate()).padStart(2, "0");
  return `archive-${y}-${m}-${d1}-${d2}`;
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function makeTree(root: string, maxDepth: number): Promise<string> {
  const lines: string[] = [path.basename(root)];
  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;
    let kids: string[];
    try { kids = await readdir(dir); } catch { return; }
    kids.sort();
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i]!;
      const last = i === kids.length - 1;
      const branch = last ? "└── " : "├── ";
      const p = path.join(dir, k);
      let isDir = false;
      try { isDir = (await stat(p)).isDirectory(); } catch {}
      lines.push(prefix + branch + k + (isDir ? "/" : ""));
      if (isDir && depth < maxDepth) {
        await walk(p, prefix + (last ? "    " : "│   "), depth + 1);
      }
    }
  }
  await walk(root, "", 0);
  return lines.join("\n") + "\n";
}

switch (command) {
  case "compact": {
    const targetArg = positionals[1];
    if (!targetArg) {
      console.error("Usage: housekeeper compact <path>");
      process.exit(1);
    }
    const target = path.resolve(expandTilde(targetArg!));

    const EXCLUDE_WEEKS   = Number(Bun.env.DEFAULT_EXCLUDE_RANGE ?? 1);
    const MAX_TREE_DEPTH  = Number(Bun.env.MAX_README_TREE_DEPTH ?? 3);
    const noZip = !!(values["no-zip"] ?? values.noZip);

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch (e) {
      console.error(`Cannot read ${target}:`, (e as Error).message);
      process.exit(1);
    }

    const entries: Array<{name: string, full: string, isDir: boolean, mtime: Date}> = [];
    for (const d of dirents) {
      if (d.name.startsWith("archive-")) continue;
      const full = path.join(target, d.name);
      const s = await stat(full);
      entries.push({ name: d.name, full, isDir: d.isDirectory(), mtime: s.mtime });
    }

    const cutoff = Date.now() - (EXCLUDE_WEEKS * 7 * 24 * 60 * 60 * 1000);
    const toMove = entries.filter(e => e.mtime.getTime() < cutoff);

    if (toMove.length === 0) {
      console.log("Nothing to compact (no items older than exclude range).");
      process.exit(0);
    }

    // bucket by local week then local day
    const weeks = new Map<string, {start: Date, days: Map<string, any[]>}>();
    for (const item of toMove) {
      const ws = mondayOfWeek(item.mtime);
      const wk = localDay(ws);
      if (!weeks.has(wk)) weeks.set(wk, { start: ws, days: new Map() });
      const w = weeks.get(wk)!;
      const dk = localDay(item.mtime);
      if (!w.days.has(dk)) w.days.set(dk, []);
      w.days.get(dk)!.push(item);
    }

    const weekList = Array.from(weeks.entries())
      .sort((a, b) => a[1].start.getTime() - b[1].start.getTime())
      .map(([, w]) => ({
        name: makeArchiveName(w.start),
        start: w.start,
        days: w.days,
        count: Array.from(w.days.values()).reduce((n, arr) => n + arr.length, 0),
      }));

    const total = toMove.length;
    const minT = new Date(Math.min(...toMove.map(e => e.mtime.getTime())));
    const maxT = new Date(Math.max(...toMove.map(e => e.mtime.getTime())));

    console.log(`Path: ${target}`);
    console.log(`Archive folders to create: ${weekList.length}`);
    console.log(`Date range: ${localDay(minT)} — ${localDay(maxT)}`);
    console.log(`Elements to re-organize: ${total}`);
    if (noZip) console.log("Mode: --no-zip (folders will not be zipped)");
    console.log("");
    for (const w of weekList) {
      console.log(`  ${w.name}  (${w.count} items)`);
    }
    console.log("");

    const ans = (prompt(noZip ? "Create the re-organized structure (no zips)? [y/N] " : "Create structure + zip each archive folder? [y/N] ") || "n").trim().toLowerCase();
    if (ans !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }

    // create
    for (const w of weekList) {
      const adir = path.join(target, w.name);
      await mkdir(adir, { recursive: true });

      for (const [dk, items] of w.days) {
        const ddir = path.join(adir, dk);
        await mkdir(ddir, { recursive: true });
        for (const it of items) {
          await rename(it.full, path.join(ddir, it.name));
        }
      }

      const tree = await makeTree(adir, MAX_TREE_DEPTH);
      await writeFile(path.join(adir, "README"), tree);
    }

    // zip + cleanup (skipped with --no-zip)
    if (!noZip) {
      for (const w of weekList) {
        const adirName = w.name;
        const zipName = adirName + ".zip";
        console.log(`Zipping ${zipName}...`);
        const p = Bun.spawn(["zip", "-r", "-q", zipName, adirName], {
          cwd: target,
          stdout: "ignore",
          stderr: "pipe",
        });
        const code = await p.exited;
        if (code === 0) {
          await rm(path.join(target, adirName), { recursive: true, force: true });
          console.log(`  done`);
        } else {
          const err = await new Response(p.stderr).text();
          console.error(`  zip failed for ${adirName}: ${err.trim()}`);
        }
      }
    }

    console.log("Compact complete.");
    break;
  }

  case "walk": {
    const entryArg = positionals[1];
    if (!entryArg) {
      console.error("Usage: housekeeper walk <entry_point>");
      process.exit(1);
    }
    const entry = path.resolve(expandTilde(entryArg));

    console.log(`Walking: ${entry}`);
    const results = await walk(entry);

    if (results.length === 0) {
      console.log(`No heavy folders found (≥ ${MIN_WALK_DATA_SIZE_MB} MB with ≤ ${WALK_DEPTH_COUNT} levels beneath).`);
    } else {
      console.log(`Heavy folders (≥${MIN_WALK_DATA_SIZE_MB} MB, ≤${WALK_DEPTH_COUNT} depth beneath):`);
      for (const r of results) {
        console.log(`  ${formatBytes(r.size).padStart(8)}  ${r.path}`);
      }
    }
    break;
  }

  case "hello": {
    const name = positionals[1] ?? "world";
    console.log(`Hello, ${name}!`);
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.log('Run "housekeeper --help" for usage.');
    process.exit(1);
}

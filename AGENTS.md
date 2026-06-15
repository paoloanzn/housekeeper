# AGENTS.md

Guidance for AI coding agents working in this repository. See
<https://agents.md/> for the file convention.

## Project Overview

- Project name: write it as `housekeeper` in prose; the installed binary is
  `housekeeper` with a `hsk` alias.
- Purpose: a minimal disk-housekeeping CLI. `walk` finds heavy folders; `compact`
  archives old top-level entries into weekly folders (zipped by default).
- Repository shape: a single flat Bun/TypeScript project. No workspace, no
  framework, zero runtime dependencies.
- Stack: Bun (v1.3.11), ESM TypeScript, `bun:test`, and `bun:ffi`. The only dev
  dependencies are `@types/bun` and `@types/node`.
- Headline: `walk` is the optimized path. On macOS it enumerates directories with
  the `getattrlistbulk(2)` syscall through `bun:ffi` plus a worker pool, ~3x
  faster than the naive `readdir`+`stat` walk it replaced.

## Environment Setup

- Install [Bun](https://bun.sh); it is the only required tool. Run `bun install`
  to fetch the two `@types` packages.
- The fast `walk` path is macOS/Apple-Silicon specific (`getattrlistbulk` via
  `/usr/lib/libSystem.B.dylib`). Off macOS, `walk()` transparently uses the
  portable async fallback in `walk.ts`.
- No secrets, network access, or services are involved. The tool only reads
  filesystem metadata and (for `compact`) moves/zips files the user points it at.

## Commands

| Purpose | Command |
| --- | --- |
| Install dev dependencies | `bun install` |
| Run the CLI from source | `bun run index.ts --help` |
| Run a command | `bun run index.ts walk ~/Library/Caches` |
| Watch mode | `bun dev` |
| Tests / walk benchmark | `bun test` |
| Benchmark a specific path | `WALK_BENCH_PATH=/some/path bun test` |
| Build standalone binary | `bun run build` (-> `dist/housekeeper`) |
| Install on PATH | `./install.sh` (override dir with `PREFIX=...`) |
| Find agent TODOs when asked | `rg -F 'TODO (AGENT)'` |

`compact` mutates the filesystem (moves files, writes zips). Do not run it
against real user directories to "verify" a change; use a throwaway temp tree.

## Repository Structure

- `index.ts`: the entire CLI. `parseArgs`, command dispatch (`compact`, `walk`,
  `hello`, `help`), and all `compact` logic (weekly bucketing, `makeTree`,
  zip+cleanup via `Bun.spawn(["zip", ...])`).
- `walk.ts`: public `walk()` entrypoint plus exported constants
  (`DEFAULT_WALK_EXCLUDE`, `WALK_DEPTH_COUNT`, `MIN_WALK_DATA_SIZE_MB`) and
  `formatBytes`. Holds the worker-pool orchestration and the portable async
  fallback (`walkPortable`).
- `walk-darwin.ts`: the macOS FFI core. `getattrlistbulk` setup, per-entry
  parsing, `walkSubtree` (full recursive subtree walk), and `listChildren` (one
  directory level, used to split work). Module-level FFI state is intentionally
  thread-local so each Worker gets its own buffers.
- `walk.worker.ts`: thin Worker that runs `walkSubtree` on one subtree and posts
  back `{ heavies, size, depthBeneath }`.
- `test/walk.test.ts`: the benchmark. Walks `~/Library/Caches` by default, prints
  timing and the heaviest folders, asserts `walk()` returns an array.
- `install.sh`: builds the standalone binary and installs it (+`hsk` symlink).
- `package.json`: scripts (`start`, `dev`, `build`, `test`) and the `housekeeper`
  / `hsk` bin entries.

## Architecture Boundaries

- `walk()` must return the same result shape (`Array<{ path; size }>`, sorted
  descending by size) regardless of platform or execution mode. The FFI path and
  `walkPortable` are kept output-identical — verify any change to one against the
  other before landing it.
- A folder is "heavy" iff `subtree size >= MIN_WALK_DATA_SIZE_MB` AND
  `subtree depth beneath <= WALK_DEPTH_COUNT`. Preserve the depth-beneath
  semantics: every file/symlink counts as one level beneath its directory.
- Sizes are logical (`st_size`). In `walk-darwin.ts` that means
  `ATTR_FILE_DATALENGTH`, matching `Bun.file().size` / `lstat().size` in the
  portable path. Do not switch to allocated/total size.
- `getattrlistbulk` parsing depends on `FSOPT_PACK_INVAL_ATTRS` for fixed-offset
  entries. The fixed offsets (entry length, returned attrs, name attrreference,
  objtype, datalength) are documented in `walk-darwin.ts` — keep the comment and
  the offsets in sync if you change the requested attribute set.
- Enumeration loops until `getattrlistbulk` returns 0 (it returns one final empty
  call past the last entry). Do not "optimize" that final call away; there is no
  reliable EOF flag.
- Symlinks are rare and counted via a single `lstatSync` for their own size; they
  are never followed (`getattrlistbulk` reports the link itself). Keep it that way
  to avoid cycles and to match the portable path.
- Worker tuning lives in `walk.ts`:
  - `WORKER_COUNT` (`WALK_WORKERS`, default 4 ≈ P-core count). More is not faster;
    >6 regresses on E-cores. The floor is the single largest subtree on one
    worker — finer splitting was tried and rejected as diminishing returns.
  - `MIN_SUBDIRS_PAR` (8): below this, a single thread beats worker startup.
  - `WORKERS_FAST`: false inside a `bun build --compile` standalone binary
    (detected via the `/$bunfs` module path), because each Worker re-bootstraps
    the embedded runtime (~0.5s). Standalone stays single-threaded. Do not remove
    this gate or the binary becomes much slower.
  - `runWorkers` resolves `null` on a worker `error` event so the caller falls
    back to single-threaded `walkSubtree`. Keep that fallback; it is the safety
    net if the worker module ever fails to load.

## Code Style

- Prefer small, direct changes. Avoid broad refactors unless the user asks.
- Never add more than the user explicitly asked for.
- Match nearby formatting (two-space indent, double quotes, semicolons, the
  aligned constant blocks in `index.ts`/`walk.ts`).
- Use `node:`-prefixed imports for Node built-ins; use Bun APIs (`Bun.file`,
  `Bun.spawn`, `Bun.env`) where the code already does.
- Use type-only imports for TypeScript types (`import type { ... }`).
- Comments should explain constraints or non-obvious behavior (syscall layout,
  kernel quirks, perf trade-offs), not restate code. The FFI/worker comments in
  `walk-darwin.ts` and `walk.ts` are load-bearing — update them with behavior
  changes; do not delete them to look shorter.
- Keep `walk()` output deterministic and sorted; keep CLI failures explicit
  (`console.error` + `process.exit(1)`) rather than silent.

## Testing

- For any change to walking, run `bun test` and confirm it passes and that the
  reported heavy folders/sizes look sane.
- When touching `walk-darwin.ts` or `walk.ts`, verify the FFI path and
  `walkPortable` still produce identical output on a few real trees (e.g. `/usr`,
  `/usr/share`) before landing.
- Validate all three execution modes when changing worker logic: `bun test`
  (workers), a `bun run index.ts walk ...` invocation (workers), and the compiled
  binary from `bun run build` (single-thread fallback — must not hang or
  re-bootstrap workers).
- The benchmark depends on real, warm filesystem caches; absolute timings vary
  with machine load and live cache churn (e.g. a running browser rewriting its
  cache slows any walker). Compare old vs new under identical back-to-back
  conditions, not against remembered numbers.
- Do not point tests or manual checks at directories you would mind mutating, and
  never run `compact` as a verification step on real data.

## Git/PR Workflow

- Human commit format: `(type) imperative summary` (e.g. `(feat) first commit`).
- AI-created commit format when the user asks for a commit:
  `(type) (<model>, reviewed T|F, tested T|F) imperative summary`.
- Before creating an AI commit, ask the user whether a human reviewed the changes
  so `reviewed T|F` is accurate.
- Mark `tested T` only after `bun test` (and any mode-specific checks above) ran
  successfully. Otherwise use `tested F`.
- Before committing, inspect `git status --short`, `git diff`, and
  `git log --oneline -10`; stage only intended files. Run `git diff --check`.
- Commit or push only when the user asks. Branch first if on `main`.

## Boundaries

- Do not commit generated artifacts: `dist/`, `node_modules/`, or any installed
  binary produced by `install.sh`.
- Do not add runtime dependencies. This is intentionally a zero-dependency Bun
  CLI; reach for a package only with explicit user approval.
- Do not replace Bun with Node/another runtime, or swap
  `bun:ffi`/`getattrlistbulk` for a different walking strategy, without explicit
  approval.
- Do not weaken the parallel/standalone/portable fallbacks as a simplification —
  they exist so `walk()` is correct and non-hanging in every execution mode.
- `compact` is destructive (moves files, deletes folders after zipping). Do not
  change its move/zip/cleanup order, default exclude window, or zip behavior
  without explicit approval, and never run it against real data unprompted.

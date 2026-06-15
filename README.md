# housekeeper

cleans up your disk. finds the heavy folders, boxes up the old junk.

a small Bun CLI. zero dependencies. one of the commands (`walk`) goes straight to
the macOS kernel with `getattrlistbulk(2)` and a worker pool, so it's ~3x faster
than the naive readdir+stat version. walks `~/Library/Caches` (123k files) in
under 100ms.

## install

```sh
curl -fsSL https://raw.githubusercontent.com/paoloanzn/housekeeper/main/install.sh | bash
```

or from a checkout:

```sh
./install.sh        # builds, drops a binary in ~/.local/bin
```

needs [bun](https://bun.sh). that's it.

## use

```sh
hsk walk ~/Library/Caches      # list heavy folders, biggest first
hsk compact ~/Downloads        # archive old files into weekly zips
hsk compact ~/Downloads --no-zip
```

`walk` shows folders ≥500MB whose subtree is ≤4 levels deep. `compact` moves
everything older than a week into `archive-YYYY-MM-DD-DD/` folders, one per week,
then zips them.

## knobs

env vars, if you care:

```
MIN_WALK_DATA_SIZE_MB   min folder size to report   (500)
WALK_DEPTH_COUNT        max subtree depth to report (4)
WALK_WORKERS            parallel walkers on macOS   (4)
DEFAULT_WALK_EXCLUDE    paths to skip               (/System, /dev, ...)
```

## dev

```sh
bun test        # benchmarks walk against a real path
bun run build   # standalone binary -> dist/housekeeper
```

non-macOS falls back to a portable async walk. same output, slower.

---

fully vibecoded ❤️.


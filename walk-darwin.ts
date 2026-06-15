// macOS fast directory walker built on getattrlistbulk(2).
//
// getattrlistbulk returns name + object type + data size for MANY directory
// entries in a single kernel call, eliminating the one-stat()-per-file ("N+1")
// problem entirely. The FFI state below is module-level, which makes it
// thread-local: each Worker importing this module gets its own buffers.

import { dlopen, FFIType, ptr } from "bun:ffi";
import { lstatSync } from "node:fs";

export type Heavy = { path: string; size: number };
export type SubtreeResult = { heavies: Heavy[]; size: number; depthBeneath: number };
export type WalkCtx = { excludes: string[]; minSize: number; maxDepth: number };

const lib = dlopen(`/usr/lib/libSystem.B.dylib`, {
  open:  { args: [FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  getattrlistbulk: {
    args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64_fast, FFIType.u64_fast],
    returns: FFIType.i32,
  },
});
const { open, close, getattrlistbulk } = lib.symbols;

const O_RDONLY = 0x0000;

// struct attrlist (24 bytes): request RETURNED_ATTRS + NAME + OBJTYPE (common)
// and DATALENGTH (file). FSOPT_PACK_INVAL_ATTRS gives every entry a fixed layout.
const ATTR_BIT_MAP_COUNT      = 5;
const ATTR_CMN_RETURNED_ATTRS = 0x80000000;
const ATTR_CMN_NAME           = 0x00000001;
const ATTR_CMN_OBJTYPE        = 0x00000008;
const ATTR_FILE_DATALENGTH    = 0x00000200;
const FSOPT_PACK_INVAL_ATTRS  = 0x00000008;

// fsobj_type_t
const VREG = 1; // regular file
const VDIR = 2; // directory
const VLNK = 5; // symlink

// Fixed per-entry field offsets (thanks to FSOPT_PACK_INVAL_ATTRS):
//   +0  u32  entry length        +24 attrreference name (i32 off, u32 len)
//   +4  attribute_set (20 bytes) +32 u32 objtype
//                                +36 u64 datalength (st_size; 0 for non-files)

const attrList = new Uint8Array(24);
{
  const dv = new DataView(attrList.buffer);
  dv.setUint16(0, ATTR_BIT_MAP_COUNT, true);
  dv.setUint32(4, ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE, true);
  dv.setUint32(16, ATTR_FILE_DATALENGTH, true);
}
const attrListPtr = ptr(attrList);

const BUF_SIZE = 1 << 20; // 1 MiB — fewer syscalls on huge directories
const buf = new Uint8Array(BUF_SIZE);
const bufPtr = ptr(buf);
const view = new DataView(buf.buffer);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function cstr(s: string): Uint8Array {
  const bytes = encoder.encode(s);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

function isExcluded(dir: string, excludes: string[]): boolean {
  for (const ex of excludes) {
    if (dir === ex || dir.startsWith(ex + "/")) return true;
  }
  return false;
}

/** Enumerate one directory: accumulate file sizes, collect child dir paths. */
function readDir(dir: string, subdirsOut: string[]): { size: number; sawLeaf: boolean } {
  const fd = open(cstr(dir), O_RDONLY);
  if (fd < 0) return { size: 0, sawLeaf: false };

  let total = 0;
  let sawLeaf = false; // any file/symlink (a leaf is one level beneath this dir)
  const prefix = dir === "/" ? "/" : dir + "/";
  try {
    for (;;) {
      const count = getattrlistbulk(fd, attrListPtr, bufPtr, BUF_SIZE, FSOPT_PACK_INVAL_ATTRS);
      if (count <= 0) break; // 0 = exhausted, <0 = error

      let p = 0;
      for (let i = 0; i < count; i++) {
        const entryLen = view.getUint32(p, true);
        const objType  = view.getUint32(p + 32, true);

        if (objType === VREG) {
          const lo = view.getUint32(p + 36, true);
          const hi = view.getUint32(p + 40, true);
          total += hi === 0 ? lo : hi * 0x100000000 + lo;
          sawLeaf = true;
        } else if (objType === VDIR) {
          subdirsOut.push(prefix + entryName(p));
        } else if (objType === VLNK) {
          // Rare; preserve the link's own size with one targeted stat.
          try { total += lstatSync(prefix + entryName(p)).size; } catch {}
          sawLeaf = true;
        }
        p += entryLen;
      }
    }
  } finally {
    close(fd);
  }
  return { size: total, sawLeaf };
}

function entryName(p: number): string {
  const nameOff = view.getInt32(p + 24, true);
  const nameLen = view.getUint32(p + 28, true);
  const start = p + 24 + nameOff;
  return decoder.decode(buf.subarray(start, start + nameLen - 1));
}

/** Fully walk a subtree, recording heavy folders found within it. */
export function walkSubtree(dir: string, ctx: WalkCtx, heaviesOut: Heavy[]): SubtreeResult {
  if (isExcluded(dir, ctx.excludes)) return { heavies: heaviesOut, size: 0, depthBeneath: 0 };

  const subdirs: string[] = [];
  const { size, sawLeaf } = readDir(dir, subdirs);
  let total = size;
  let maxBeneath = subdirs.length > 0 || sawLeaf ? 1 : 0;

  for (const sub of subdirs) {
    const res = walkSubtree(sub, ctx, heaviesOut);
    total += res.size;
    if (res.depthBeneath + 1 > maxBeneath) maxBeneath = res.depthBeneath + 1;
  }

  if (maxBeneath <= ctx.maxDepth && total >= ctx.minSize) {
    heaviesOut.push({ path: dir, size: total });
  }
  return { heavies: heaviesOut, size: total, depthBeneath: maxBeneath };
}

/** List a directory's immediate children — used to split work across workers. */
export function listChildren(dir: string): { subdirs: string[]; fileSize: number; sawLeaf: boolean } {
  const subdirs: string[] = [];
  const { size, sawLeaf } = readDir(dir, subdirs);
  return { subdirs, fileSize: size, sawLeaf };
}

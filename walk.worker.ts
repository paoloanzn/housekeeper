// Worker: walks one subtree with the macOS bulk walker and returns its
// heavy folders plus the subtree's aggregate size/depth for the parent to fold in.
import { walkSubtree, type WalkCtx, type Heavy } from "./walk-darwin";

declare const self: Worker;

type Job = { dir: string; ctx: WalkCtx };

self.onmessage = (e: MessageEvent<Job>) => {
  const { dir, ctx } = e.data;
  const heavies: Heavy[] = [];
  const { size, depthBeneath } = walkSubtree(dir, ctx, heavies);
  self.postMessage({ heavies, size, depthBeneath });
};

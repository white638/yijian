import type { cropCandidate } from "./core.js";
export function mountPopup(options?: {
  chromeApi?: unknown;
  root?: Document;
  clipboard?: Pick<Clipboard, "writeText">;
  crop?: typeof cropCandidate;
}): void;

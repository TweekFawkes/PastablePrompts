// The frontend's copy of every prompt on disk, shared by the editor and sidebar.
import { api, type PromptMeta } from "./api";

export const prompts = new Map<string, PromptMeta>();

const listeners = new Set<() => void>();
let queued = false;

export function onPromptsChanged(fn: () => void) {
  listeners.add(fn);
}

function changed() {
  if (queued) return;
  queued = true;
  // A microtask, not requestAnimationFrame: macOS pauses animation frames
  // while the window is hidden, and the list should still stay current.
  queueMicrotask(() => {
    queued = false;
    listeners.forEach((fn) => fn());
  });
}

export function upsertPrompt(meta: PromptMeta) {
  prompts.set(meta.id, meta);
  changed();
}

export function removePrompt(id: string) {
  if (prompts.delete(id)) changed();
}

export function patchPrompt(id: string, patch: Partial<PromptMeta>) {
  const meta = prompts.get(id);
  if (!meta) return;
  prompts.set(id, { ...meta, ...patch });
  changed();
}

export async function refreshPrompts() {
  const list = await api.list();
  prompts.clear();
  for (const meta of list) prompts.set(meta.id, meta);
  changed();
}

/** Most recent activity: last edit or last paste, whichever is later. */
export function lastActivity(meta: PromptMeta): number {
  return Math.max(meta.modifiedMs, meta.lastUsedMs ?? 0);
}

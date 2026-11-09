// Typed wrappers around the Rust commands in src-tauri/src.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface PromptMeta {
  id: string;
  fileName: string;
  content: string;
  /** The name it was given, shown instead of its first line. */
  name: string | null;
  createdMs: number;
  modifiedMs: number;
  lastUsedMs: number | null;
  starred: boolean;
}

export interface Session {
  open: string[];
  active: string | null;
}

export interface Projects {
  /** The open project's folder, or null for the home folder. */
  current: string | null;
  /** Recently opened folders, most recent first. */
  recent: string[];
}

export const api = {
  promptsDir: () => invoke<string>("prompts_dir"),
  list: () => invoke<PromptMeta[]>("prompt_list"),
  create: () => invoke<{ id: string; createdMs: number }>("prompt_create"),
  read: (id: string) => invoke<string>("prompt_read", { id }),
  save: (id: string, content: string) => invoke<PromptMeta | null>("prompt_save", { id, content }),
  close: (id: string, content: string) => invoke<PromptMeta | null>("prompt_close", { id, content }),
  rename: (id: string, name: string, content: string) =>
    invoke<PromptMeta | null>("prompt_rename", { id, name, content }),
  star: (id: string, starred: boolean) => invoke<void>("prompt_star", { id, starred }),
  markUsed: (id: string) => invoke<number>("prompt_mark_used", { id }),
  sessionGet: () => invoke<Session>("session_get"),
  sessionSet: (session: Session) => invoke<void>("session_set", { session }),
  projectGet: () => invoke<Projects>("project_get"),
  projectOpen: (path: string) => invoke<Projects>("project_open", { path }),
  projectClose: () => invoke<Projects>("project_close"),
  quit: () => invoke<void>("app_quit"),

  ptySpawn(
    cwd: string | null,
    cols: number,
    rows: number,
    onOutput: (data: ArrayBuffer) => void,
    onExit: (code: number) => void,
  ) {
    const output = new Channel<ArrayBuffer>();
    output.onmessage = onOutput;
    const exit = new Channel<number>();
    exit.onmessage = onExit;
    return invoke<number>("pty_spawn", { cwd, cols, rows, onOutput: output, onExit: exit });
  },
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),
};

/** `20261028-143205` (or `20261028-143205_2`) -> local time in ms. */
export function createdFromId(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}

/** First non-empty line, trimmed: what a prompt is called in tabs and the sidebar. */
export function titleOf(content: string): string {
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** `/Users/me/code` -> `~/code` */
export function tildePath(path: string): string {
  return path.replace(/^(\/Users|\/home)\/[^/]+/, "~");
}

/** The last part of a path: `/Users/me/code/app` -> `app` */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

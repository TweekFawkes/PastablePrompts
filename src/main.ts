import "./styles.css";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { Menu, type MenuOptions } from "@tauri-apps/api/menu";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, baseName, tildePath, type Projects } from "./api";
import { Editors, type SaveStatus } from "./editor";
import { patchPrompt, prompts, refreshPrompts } from "./prompts";
import { Sidebar } from "./sidebar";
import { Terminals } from "./terminals";

const isMac = navigator.userAgent.includes("Mac");
const modKey = isMac ? "⌘" : "Ctrl+";
const $ = (id: string) => document.getElementById(id)!;

const editors = new Editors($("editor-host"), $("editor-bar"), `${modKey}T for a new one.`);
const terminals = new Terminals($("terminal-host"), $("terminal-bar"), $("terminal-empty"));
const sidebar = new Sidebar(
  $("sidebar"),
  {
    open: (id) => void editors.open(id),
    paste: (id) => void copyAndPaste(id),
    star(id, starred) {
      patchPrompt(id, { starred });
      api.star(id, starred).catch(() => patchPrompt(id, { starred: !starred }));
    },
    isOpen: (id) => editors.has(id),
    leave: () => editors.focus(),
  },
  `${modKey}P`,
);

$("paste-kbd").textContent = isMac ? "⌘↵" : "Ctrl+↵";
$("paste-button").addEventListener("mousedown", (e) => e.preventDefault());
$("paste-button").addEventListener("click", () => void copyAndPaste());
$("terminal-new").addEventListener("click", () => void terminals.newTab());
$("project-button").addEventListener("mousedown", (e) => e.preventDefault());
$("project-button").addEventListener("click", () => void showProjectMenu());

// ---- Copy & Paste --------------------------------------------------------

let toastTimer: number | undefined;
function toast(message: string) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 2600);
}

let pendingConfirm: ((ok: boolean) => void) | null = null;
function confirmInTerminal(message: string, okLabel: string): Promise<boolean> {
  pendingConfirm?.(false);
  const bar = $("confirm-bar");
  const text = document.createElement("span");
  text.textContent = message;
  const ok = document.createElement("button");
  ok.className = "primary";
  ok.textContent = okLabel;
  const cancel = document.createElement("button");
  cancel.textContent = "Cancel";
  bar.replaceChildren(text, ok, cancel);
  bar.hidden = false;

  return new Promise((resolve) => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      done(false);
    };
    const done = (result: boolean) => {
      pendingConfirm = null;
      bar.hidden = true;
      bar.replaceChildren();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    pendingConfirm = done;
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    window.addEventListener("keydown", onKey, true);
    cancel.focus();
  });
}

/**
 * Copies a prompt to the clipboard and pastes it into the active terminal,
 * without pressing Enter: the user reads it there and submits it themselves.
 * With no id, uses the editor's active tab.
 */
async function copyAndPaste(id?: string) {
  id ??= editors.activeId ?? undefined;
  const raw = (id && (editors.liveText(id) ?? prompts.get(id)?.content)) || "";
  const text = raw.replace(/\r\n?/g, "\n").trimEnd();
  if (!text.trim()) {
    toast("Nothing to paste: this prompt is empty.");
    return;
  }

  writeText(text).catch(() => {});
  if (!terminals.hasTerminal) {
    toast(`Copied. Open a terminal (${modKey}T in the terminal pane) to paste into it.`);
    return;
  }
  if (!terminals.pasteIsSafe(text)) {
    const lines = text.split("\n").length;
    const ok = await confirmInTerminal(
      `The program in this terminal doesn't accept multi-line pastes safely, so each of these ${lines} lines would run as soon as it's pasted.`,
      "Paste anyway",
    );
    if (!ok) {
      editors.focus();
      return;
    }
  }

  terminals.paste(text);
  terminals.focus();
  const button = $("paste-button");
  button.classList.add("flash");
  setTimeout(() => button.classList.remove("flash"), 150);

  if (id) {
    const promptId = id;
    await editors.flush(promptId);
    api
      .markUsed(promptId)
      .then((ms) => patchPrompt(promptId, { lastUsedMs: ms }))
      .catch(() => {});
  }
}

// ---- Projects ------------------------------------------------------------

let projects: Projects = { current: null, recent: [] };

function showProject(state: Projects) {
  projects = state;
  const dir = state.current;
  const button = $("project-button");
  button.classList.toggle("none", !dir);
  button.title = dir
    ? `New terminals start in ${tildePath(dir)}`
    : "No project: new terminals start in your home folder. Click to open one.";
  $("project-name").textContent = dir ? baseName(dir) : "No project";
  getCurrentWindow()
    .setTitle(dir ? `${baseName(dir)} — Pastable Prompts` : "Pastable Prompts")
    .catch(() => {});
}

/** Makes `dir` the project (null for none) and opens a terminal in it. */
async function switchProject(dir: string | null) {
  try {
    showProject(dir ? await api.projectOpen(dir) : await api.projectClose());
  } catch (e) {
    toast(`Couldn't open that project: ${e}`);
    return;
  }
  await terminals.openIn(projects.current);
}

// ⌘O can arrive from both the File menu and the keydown handler; only show
// one folder picker at a time.
let choosingProject = false;
async function chooseProject() {
  if (choosingProject) return;
  choosingProject = true;
  try {
    const dir = await openDialog({ directory: true, title: "Open Project" });
    if (dir) await switchProject(dir);
  } finally {
    choosingProject = false;
  }
}

let projectMenu: Menu | null = null;
async function showProjectMenu() {
  const items: NonNullable<MenuOptions["items"]> = projects.recent.map((dir) => ({
    text: tildePath(dir),
    checked: dir === projects.current,
    action: () => void switchProject(dir),
  }));
  if (items.length) items.push({ item: "Separator" });
  items.push(
    { text: "Open Folder…", accelerator: "CmdOrCtrl+O", action: () => void chooseProject() },
    { text: "Close Project", enabled: projects.current !== null, action: () => void switchProject(null) },
  );
  // Free the last menu's native resources; it's been dismissed by now.
  void projectMenu?.close();
  projectMenu = await Menu.new({ items });
  const rect = $("project-button").getBoundingClientRect();
  await projectMenu.popup(new LogicalPosition(rect.left, rect.bottom));
}

// ---- Save status, session, layout ----------------------------------------

let statusTimer: number | undefined;
editors.onSaveStatus = (status: SaveStatus, detail?: string) => {
  const el = $("save-status");
  clearTimeout(statusTimer);
  el.classList.toggle("error", status === "error");
  el.title = detail ?? "";
  if (status === "saving") {
    statusTimer = window.setTimeout(() => (el.textContent = "Saving…"), 300);
  } else if (status === "saved") {
    el.textContent = "Saved";
  } else {
    el.textContent = "Couldn't save";
  }
};

let sessionTimer: number | undefined;
editors.onTabsChanged = () => {
  sidebar.render();
  clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => api.sessionSet(editors.session()).catch(() => {}), 300);
};

async function saveEverything() {
  clearTimeout(sessionTimer);
  await editors.flushAll();
  await api.sessionSet(editors.session()).catch(() => {});
}

function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Preferences are a convenience; ignore storage failures.
  }
}

const DEFAULT_SPLIT = 1 / 3;
function setSplit(fraction: number) {
  $("main").style.gridTemplateRows = `minmax(0, ${fraction}fr) 5px minmax(0, ${1 - fraction}fr)`;
}
setSplit(Number(loadPref("split")) || DEFAULT_SPLIT);

const divider = $("divider");
divider.addEventListener("pointerdown", (e) => {
  const main = $("main");
  const rect = main.getBoundingClientRect();
  let fraction = DEFAULT_SPLIT;
  divider.setPointerCapture(e.pointerId);
  main.classList.add("dragging");
  divider.onpointermove = (ev) => {
    fraction = Math.min(0.85, Math.max(0.12, (ev.clientY - rect.top) / rect.height));
    setSplit(fraction);
  };
  divider.onpointerup = () => {
    divider.onpointermove = divider.onpointerup = null;
    main.classList.remove("dragging");
    savePref("split", String(fraction));
  };
});
divider.addEventListener("dblclick", () => {
  setSplit(DEFAULT_SPLIT);
  savePref("split", String(DEFAULT_SPLIT));
});

function toggleSidebar() {
  const hidden = $("app").classList.toggle("no-sidebar");
  savePref("sidebarHidden", hidden ? "1" : "");
}
if (loadPref("sidebarHidden")) $("app").classList.add("no-sidebar");

// ---- Keyboard shortcuts --------------------------------------------------

type Pane = "editor" | "terminal" | "sidebar";

function focusedPane(): Pane {
  const el = document.activeElement;
  if (el?.closest("#terminal-pane")) return "terminal";
  if (el?.closest("#sidebar")) return "sidebar";
  return "editor";
}

function cycleTabs(pane: Pane, delta: number) {
  if (pane === "terminal") terminals.cycle(delta);
  else editors.cycle(delta);
}

function shortcut(e: KeyboardEvent, pane: Pane): (() => void) | null {
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Tab") {
    return () => cycleTabs(pane, e.shiftKey ? -1 : 1);
  }
  // Cmd on macOS. Elsewhere Ctrl, plus Shift while in the terminal so that
  // Ctrl+W, Ctrl+T and friends still reach the shell.
  const mod = isMac
    ? e.metaKey && !e.ctrlKey && !e.altKey
    : e.ctrlKey && !e.metaKey && !e.altKey && (pane !== "terminal" || e.shiftKey);
  if (!mod) return null;

  switch (e.code) {
    case "Enter":
    case "NumpadEnter":
      return () => void copyAndPaste(pane === "sidebar" ? (sidebar.selectedId() ?? undefined) : undefined);
    case "KeyT":
      return pane === "terminal" ? () => void terminals.newTab() : () => void editors.newTab();
    case "KeyN":
      return () => void editors.newTab();
    case "KeyW":
      return pane === "terminal" ? () => terminals.closeActive() : () => editors.closeActive();
    case "KeyO":
      return () => void chooseProject();
    case "KeyD":
      return pane === "editor" ? () => void editors.duplicate() : null;
    case "KeyP":
      return () => sidebar.focusSearch();
    case "KeyB":
      return toggleSidebar;
    case "Digit1":
      return () => editors.focus();
    case "Digit2":
      return () => terminals.focus();
    case "BracketRight":
    case "BracketLeft":
      return isMac && e.shiftKey ? () => cycleTabs(pane, e.code === "BracketRight" ? 1 : -1) : null;
  }
  return null;
}

// Capture phase, so these win over the editor's and terminal's own handling.
window.addEventListener(
  "keydown",
  (e) => {
    const action = shortcut(e, focusedPane());
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  },
  true,
);

// ---- Lifecycle -----------------------------------------------------------

// Leaving the window (switching apps, clicking the Dock) saves everything.
window.addEventListener("blur", () => void saveEverything());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void saveEverything();
});

// Pick up prompts changed outside the app when the window comes back.
let lastRefresh = 0;
window.addEventListener("focus", () => {
  if (Date.now() - lastRefresh < 2000) return;
  lastRefresh = Date.now();
  refreshPrompts().catch(() => {});
});

void getCurrentWindow().onCloseRequested(saveEverything);
void listen("open-folder", () => void chooseProject());
void listen("quit-requested", async () => {
  await saveEverything();
  await api.quit();
});

async function start() {
  const [dir, session, project] = await Promise.all([
    api.promptsDir(),
    api.sessionGet(),
    api.projectGet(),
    refreshPrompts(),
  ]);
  lastRefresh = Date.now();
  sidebar.setFolder(dir);
  // Reopen the last project, as Zed does, so the first terminal starts there.
  showProject(project);
  terminals.cwd = project.current;
  await Promise.all([editors.restore(session), terminals.newTab(false)]);
  editors.focus();
}

start().catch((e) => toast(`Startup failed: ${e}`));

// The terminal pane: one ghostty-web terminal and one shell per tab.
import { FitAddon, Terminal, init, type ITheme } from "ghostty-web";
import { api } from "./api";
import { TermScrollbar } from "./scrollbar";
import { TabBar } from "./tabbar";

const ready = init();

// ghostty-web measures scrollback in bytes, not lines. Its default (10 KB)
// kept only about 280 lines in a wide window; this keeps about 7,500.
const SCROLLBACK_BYTES = 20_000_000;
const MAX_WHEEL_LINES = 20;

const theme: ITheme = {
  background: "#121418",
  foreground: "#d7dae0",
  cursor: "#e0a050",
  cursorAccent: "#121418",
  selectionBackground: "#3a4150",
  black: "#1e2127",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#d19a66",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#ef7b84",
  brightGreen: "#a9d48a",
  brightYellow: "#e5c07b",
  brightBlue: "#7cc0f5",
  brightMagenta: "#d48ee8",
  brightCyan: "#6cc8d4",
  brightWhite: "#ffffff",
};

const fontFamily = `"SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace`;

/**
 * Programs that turn on mouse reporting (Claude Code's fullscreen mode, vim
 * with mouse=a, htop...) scroll their own history, so the wheel has to reach
 * them as mouse-wheel reports. ghostty-web sends arrow keys instead, which
 * Claude Code reads as "previous prompt". Returns false to leave other
 * programs to ghostty-web, which scrolls the terminal's own history.
 */
function mouseWheel(term: Terminal, canvas: HTMLElement, send: (data: string) => void) {
  // Pixels scrolled that don't add up to a whole line yet.
  let pending = 0;
  return (e: WheelEvent): boolean => {
    if (!term.hasMouseTracking()) return false;
    const rect = canvas.getBoundingClientRect();
    const cellW = rect.width / term.cols;
    const cellH = rect.height / term.rows;
    const px =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY * cellH
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? e.deltaY * rect.height
          : e.deltaY;
    if (Math.sign(px) !== Math.sign(pending)) pending = 0;
    pending += px;
    const lines = Math.trunc(pending / cellH);
    if (!lines) return true;
    pending -= lines * cellH;

    const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - rect.left) / cellW) + 1));
    const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - rect.top) / cellH) + 1));
    const button = lines < 0 ? 64 : 65;
    // The legacy encoding is one byte per value; keep it ASCII so it survives
    // the trip to the shell as UTF-8.
    const byte = (n: number) => String.fromCharCode(32 + Math.min(n, 95));
    const report = term.getMode(1006)
      ? `\x1b[<${button};${col};${row}M`
      : `\x1b[M${byte(button)}${byte(col)}${byte(row)}`;
    send(report.repeat(Math.min(Math.abs(lines), MAX_WHEEL_LINES)));
    return true;
  };
}

interface TermTab {
  key: string;
  n: number;
  term: Terminal;
  fit: FitAddon;
  bar: TermScrollbar;
  el: HTMLElement;
  ptyId: number | null;
  /** The name it was given, which replaces the title the shell sets. */
  name: string;
  title: string;
  /** Input waiting to be written; writes go one at a time so they stay in order. */
  pending: string;
  writing: boolean;
  /** Anything has been sent to the shell: typing, a paste, or even the
   *  terminal's own reply to a query. Until then it's safe to close. */
  used: boolean;
}

export class Terminals {
  private tabs: TermTab[] = [];
  private active: TermTab | null = null;
  private count = 0;
  private tabBar: TabBar;
  /** Where new terminals start: the project folder, or null for home. */
  cwd: string | null = null;

  constructor(
    private host: HTMLElement,
    tabBarHost: HTMLElement,
    private empty: HTMLElement,
  ) {
    this.tabBar = new TabBar(tabBarHost, "New terminal", {
      select: (key) => this.activate(this.find(key)!, true),
      close: (key) => this.close(this.find(key)!),
      add: () => void this.newTab(),
      rename: (key, name) => {
        const tab = this.find(key);
        if (tab) tab.name = name;
        this.render();
      },
    });
    this.render();
  }

  get hasTerminal(): boolean {
    return this.active !== null;
  }

  focus() {
    this.active?.term.focus();
  }

  async newTab(focus = true) {
    await ready;
    const n = ++this.count;
    const el = document.createElement("div");
    el.className = "term";
    this.host.append(el);

    const term = new Terminal({ fontFamily, fontSize: 13, cursorBlink: true, theme, scrollback: SCROLLBACK_BYTES });
    // The scrollbar below replaces the one ghostty-web draws over the text,
    // which only appears while scrolling.
    (term as unknown as { showScrollbar(): void }).showScrollbar = () => {};
    const fit = new FitAddon();
    term.loadAddon(fit);
    const bar = new TermScrollbar(el, term);
    const tab: TermTab = {
      key: `t${n}`,
      n,
      term,
      fit,
      bar,
      el,
      ptyId: null,
      name: "",
      title: "",
      pending: "",
      writing: false,
      used: false,
    };
    const at = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    // Show it before opening so the terminal can measure its container.
    this.activate(tab, false);
    term.open(el);
    fit.fit();

    term.attachCustomWheelEventHandler(mouseWheel(term, el.querySelector("canvas")!, (data) => this.send(tab, data)));
    term.onData((data) => {
      // Typing takes you back to the shell prompt, as in any terminal.
      term.scrollToBottom();
      this.send(tab, data);
    });
    term.onResize(({ cols, rows }) => {
      if (tab.ptyId !== null) api.ptyResize(tab.ptyId, cols, rows).catch(() => {});
    });
    term.onTitleChange((title) => {
      tab.title = title;
      this.render();
    });

    try {
      tab.ptyId = await api.ptySpawn(
        this.cwd,
        term.cols,
        term.rows,
        (data) => this.output(tab, new Uint8Array(data)),
        () => this.close(tab),
      );
      void this.pump(tab);
    } catch (e) {
      term.write(`\x1b[31mCould not start a shell: ${e}\x1b[0m\r\n`);
    }
    fit.observeResize();
    if (focus) term.focus();
  }

  /**
   * Makes `dir` (null for home) where new terminals start, and opens one
   * there. Terminals nothing has been sent to yet are replaced by it; any
   * you've used keep running where they are.
   */
  async openIn(dir: string | null) {
    this.cwd = dir;
    const unused = this.tabs.filter((t) => !t.used);
    await this.newTab();
    for (const t of unused) if (!t.used) this.close(t);
  }

  closeActive() {
    if (this.active) this.close(this.active);
  }

  cycle(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length], true);
  }

  /** True if `text` can't run by accident: it's one line, or the program
   *  in the terminal accepts bracketed paste. */
  pasteIsSafe(text: string): boolean {
    return !text.includes("\n") || (this.active?.term.hasBracketedPaste() ?? false);
  }

  /**
   * Pastes into the active terminal without pressing Enter. When the running
   * program supports bracketed paste (shells, Claude Code, vim...), the text
   * arrives as one block instead of being run line by line.
   */
  paste(text: string) {
    const term = this.active?.term;
    if (!term) return;
    // No escape characters, so pasted text can't end the bracketed paste early.
    const clean = text.replace(/\x1b/g, "");
    term.paste(term.hasBracketedPaste() ? clean : clean.replace(/\n/g, "\r"));
  }

  private find(key: string): TermTab | undefined {
    return this.tabs.find((t) => t.key === key);
  }

  private activate(tab: TermTab, focus: boolean) {
    this.active = tab;
    for (const t of this.tabs) t.el.classList.toggle("hidden", t !== tab);
    tab.bar.update();
    this.render();
    if (focus) tab.term.focus();
  }

  private close(tab: TermTab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    const hadFocus = tab.el.contains(document.activeElement);
    this.tabs.splice(i, 1);
    if (tab.ptyId !== null) api.ptyKill(tab.ptyId).catch(() => {});
    tab.fit.dispose();
    tab.term.dispose();
    tab.el.remove();
    if (tab === this.active) {
      this.active = null;
      const next = this.tabs[i] ?? this.tabs[i - 1];
      if (next) this.activate(next, hadFocus);
    }
    this.render();
  }

  /**
   * Shows the shell's output. ghostty-web jumps to the bottom on every write,
   * so you couldn't scroll back while something kept redrawing (Claude Code's
   * spinner, a build). This keeps the view on the lines you were reading,
   * allowing for any new lines the output pushed into history.
   */
  private output(tab: TermTab, data: Uint8Array) {
    const { term } = tab;
    const back = term.getViewportY();
    const history = term.getScrollbackLength();
    term.write(data);
    if (back > 0 && term.buffer.active.type === "normal") {
      term.scrollLines(-(back + term.getScrollbackLength() - history));
    }
    tab.bar.update();
  }

  private send(tab: TermTab, data: string) {
    tab.used = true;
    tab.pending += data;
    if (!tab.writing) void this.pump(tab);
  }

  private async pump(tab: TermTab) {
    if (tab.ptyId === null) return;
    tab.writing = true;
    while (tab.pending) {
      const chunk = tab.pending;
      tab.pending = "";
      await api.ptyWrite(tab.ptyId, chunk).catch(() => {});
    }
    tab.writing = false;
  }

  private render() {
    this.empty.hidden = this.tabs.length > 0;
    this.tabBar.render(
      this.tabs.map((t) => {
        const name = t.name || t.title || `Terminal ${t.n}`;
        return { key: t.key, label: name, name, tooltip: t.title || undefined, active: t === this.active };
      }),
    );
  }
}

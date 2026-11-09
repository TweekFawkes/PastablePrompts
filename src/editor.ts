// The editor pane: one CodeMirror view, one EditorState per tab, and every
// tab autosaved to its prompt file a moment after typing stops.
import { EditorState, type Extension, type Text, type StateEffect } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { api, createdFromId, type Session } from "./api";
import { prompts, removePrompt, upsertPrompt } from "./prompts";
import { TabBar } from "./tabbar";

const SAVE_DELAY_MS = 400;
const TAB_LABEL_MAX = 28;

export type SaveStatus = "saving" | "saved" | "error";

interface EditorTab {
  id: string;
  state: EditorState;
  scroll: StateEffect<unknown> | null;
  /** The name it was given, or "" to be called by its first line. */
  name: string;
  /** Its first line, in full. */
  title: string;
  /** Text last written to (or read from) disk, so unchanged tabs aren't rewritten. */
  savedText: string;
  saveTimer: number | undefined;
  /** Saves for one tab run one at a time, in order. */
  saving: Promise<void>;
}

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "14px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    ".cm-content": { caretColor: "var(--accent)", padding: "10px 0 40px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      { backgroundColor: "var(--selection)" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--fg-faint)", border: "none", paddingLeft: "6px" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-dim)" },
    ".cm-activeLine": { backgroundColor: "var(--active-line)" },
    ".cm-selectionMatch": { backgroundColor: "var(--match)" },
    ".cm-placeholder": { color: "var(--fg-faint)", fontStyle: "italic" },
    ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "1px solid var(--search-match-border)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
    ".cm-panels": { backgroundColor: "var(--bg-elev)", color: "var(--fg)" },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
    ".cm-panel.cm-search": { fontFamily: "var(--ui)", fontSize: "12px", padding: "6px 8px" },
    ".cm-textfield": {
      backgroundColor: "var(--bg)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
      padding: "3px 6px",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--bg-hover)",
      color: "var(--fg)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
    },
  },
  { dark: true },
);

/** First non-empty line, looking only at the top of the document. */
function titleOfDoc(doc: Text): string {
  for (let i = 1; i <= Math.min(doc.lines, 200); i++) {
    const t = doc.line(i).text.trim();
    if (t) return t;
  }
  return "";
}

function tabLabel(title: string): string {
  if (!title) return "Untitled";
  return title.length > TAB_LABEL_MAX ? title.slice(0, TAB_LABEL_MAX - 1) + "…" : title;
}

export class Editors {
  readonly view: EditorView;
  private tabs: EditorTab[] = [];
  private active: EditorTab | null = null;
  private tabBar: TabBar;
  private extensions: Extension[];

  /** Called when tabs open, close or switch, so the session can be saved. */
  onTabsChanged = () => {};
  onSaveStatus = (_status: SaveStatus, _detail?: string) => {};

  constructor(host: HTMLElement, tabBarHost: HTMLElement, newTabHint: string) {
    this.extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      placeholder(`Write a prompt or command. It saves itself as you type.  ${newTabHint}`),
      theme,
      EditorView.updateListener.of((update) => {
        const tab = this.active;
        if (!update.docChanged || !tab) return;
        this.scheduleSave(tab);
        const title = titleOfDoc(update.state.doc);
        if (title !== tab.title) {
          tab.title = title;
          if (!tab.name) this.render();
        }
      }),
    ];
    this.view = new EditorView({ parent: host, state: EditorState.create({ extensions: this.extensions }) });
    this.tabBar = new TabBar(tabBarHost, "New prompt", {
      select: (id) => this.activate(this.find(id)!),
      close: (id) => void this.close(this.find(id)!),
      add: () => void this.newTab(),
      rename: (id, name) => this.rename(this.find(id)!, name),
    });
  }

  get activeId(): string | null {
    return this.active?.id ?? null;
  }

  activeText(): string {
    return this.view.state.doc.toString();
  }

  has(id: string): boolean {
    return this.find(id) !== undefined;
  }

  /** Text of an open tab, including edits that haven't been saved yet. */
  liveText(id: string): string | undefined {
    const tab = this.find(id);
    return tab && this.text(tab);
  }

  session(): Session {
    return { open: this.tabs.map((t) => t.id), active: this.activeId };
  }

  focus() {
    this.view.focus();
  }

  async newTab() {
    const { id } = await api.create();
    this.activate(this.addTab(id, ""));
    this.view.focus();
  }

  /** Opens a prompt from the sidebar, or switches to it if it's already open. */
  async open(id: string) {
    const tab = this.find(id) ?? this.addTab(id, prompts.get(id)?.content ?? (await api.read(id)));
    this.activate(tab);
    this.view.focus();
  }

  async restore(session: Session) {
    for (const id of session.open) {
      if (this.has(id)) continue;
      this.addTab(id, prompts.get(id)?.content ?? (await api.read(id)), true);
    }
    const active = (session.active && this.find(session.active)) || this.tabs.at(-1);
    if (active) this.activate(active);
    else await this.newTab();
  }

  /** Opens a copy of the active tab, with the same text and name, beside it. */
  async duplicate() {
    const source = this.active;
    if (!source) return;
    const text = this.text(source);
    const { id } = await api.create();
    const tab = this.addTab(id, text);
    // Nothing is on disk for the copy yet, so its first save must write.
    tab.savedText = "";
    this.activate(tab);
    this.view.focus();
    if (source.name) this.rename(tab, source.name);
    else void this.save(tab);
  }

  closeActive() {
    if (this.active) void this.close(this.active);
  }

  cycle(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
    this.view.focus();
  }

  flush(id: string): Promise<void> {
    const tab = this.find(id);
    return tab ? this.save(tab) : Promise.resolve();
  }

  flushAll(): Promise<void> {
    return Promise.all(this.tabs.map((t) => this.save(t))).then(() => {});
  }

  private find(id: string): EditorTab | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  private text(tab: EditorTab): string {
    return (tab === this.active ? this.view.state : tab.state).doc.toString();
  }

  private addTab(id: string, content: string, atEnd = false): EditorTab {
    const state = EditorState.create({ doc: content, extensions: this.extensions });
    const tab: EditorTab = {
      id,
      state,
      scroll: null,
      name: prompts.get(id)?.name ?? "",
      title: titleOfDoc(state.doc),
      savedText: content,
      saveTimer: undefined,
      saving: Promise.resolve(),
    };
    const at = this.active && !atEnd ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(at, 0, tab);
    return tab;
  }

  private activate(tab: EditorTab) {
    if (tab === this.active) return;
    const prev = this.active;
    if (prev) {
      prev.state = this.view.state;
      prev.scroll = this.view.scrollSnapshot();
      void this.save(prev);
    }
    this.active = tab;
    this.view.setState(tab.state);
    if (tab.scroll) this.view.dispatch({ effects: tab.scroll });
    this.render();
    this.onTabsChanged();
  }

  private async close(tab: EditorTab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (tab === this.active) tab.state = this.view.state;
    clearTimeout(tab.saveTimer);
    this.tabs.splice(i, 1);
    if (tab === this.active) {
      this.active = null;
      const next = this.tabs[i] ?? this.tabs[i - 1];
      if (next) this.activate(next);
      else await this.newTab();
      this.view.focus();
    }
    this.render();
    this.onTabsChanged();

    // The final save: renames the file to match its first line, or deletes
    // it if the tab was left empty.
    await tab.saving;
    try {
      const meta = await api.close(tab.id, tab.state.doc.toString());
      if (meta) upsertPrompt(meta);
      else removePrompt(tab.id);
    } catch (e) {
      this.onSaveStatus("error", String(e));
    }
  }

  /** Names the tab ("" goes back to its first line) and renames its file to match. */
  private rename(tab: EditorTab, name: string) {
    tab.name = name;
    this.render();
    clearTimeout(tab.saveTimer);
    tab.saveTimer = undefined;
    tab.saving = tab.saving.then(async () => {
      const text = this.text(tab);
      this.onSaveStatus("saving");
      try {
        const meta = await api.rename(tab.id, name, text);
        tab.savedText = text;
        if (meta) upsertPrompt(meta);
        this.onSaveStatus("saved");
      } catch (e) {
        this.onSaveStatus("error", String(e));
      }
    });
  }

  private scheduleSave(tab: EditorTab) {
    clearTimeout(tab.saveTimer);
    tab.saveTimer = window.setTimeout(() => void this.save(tab), SAVE_DELAY_MS);
  }

  private save(tab: EditorTab): Promise<void> {
    clearTimeout(tab.saveTimer);
    tab.saveTimer = undefined;
    tab.saving = tab.saving.then(async () => {
      if (!this.tabs.includes(tab)) return;
      const text = this.text(tab);
      if (text === tab.savedText) return;
      this.onSaveStatus("saving");
      try {
        const meta = await api.save(tab.id, text);
        tab.savedText = text;
        if (meta) upsertPrompt(meta);
        // A tab restored before it had a file doesn't know its name yet.
        if (meta && (meta.name ?? "") !== tab.name) {
          tab.name = meta.name ?? "";
          this.render();
        }
        this.onSaveStatus("saved");
      } catch (e) {
        this.onSaveStatus("error", String(e));
      }
    });
    return tab.saving;
  }

  private render() {
    this.tabBar.render(
      this.tabs.map((t) => ({
        key: t.id,
        label: tabLabel(t.name || t.title),
        name: t.name || t.title,
        tooltip: `Created ${new Date(createdFromId(t.id)).toLocaleString()}`,
        active: t === this.active,
      })),
    );
  }
}

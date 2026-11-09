// The right-hand list of prompts: favorites on top, then everything else,
// most recently edited or pasted first, filtered by the search box.
import { tildePath, titleOf, type PromptMeta } from "./api";
import { lastActivity, onPromptsChanged, prompts } from "./prompts";

const MAX_ROWS = 300;

export interface SidebarActions {
  open(id: string): void;
  paste(id: string): void;
  star(id: string, starred: boolean): void;
  isOpen(id: string): boolean;
  /** Escape from an empty search box: hand focus back to the editor. */
  leave(): void;
}

const lowered = new WeakMap<PromptMeta, string>();
function searchText(meta: PromptMeta): string {
  let s = lowered.get(meta);
  if (s === undefined) {
    s = (meta.fileName + "\n" + (meta.name ?? "") + "\n" + meta.content).toLowerCase();
    lowered.set(meta, s);
  }
  return s;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minute = 60_000;
  if (diff < minute) return "just now";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}m ago`;
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  if (diff < 6 * 24 * 60 * minute) return d.toLocaleDateString([], { weekday: "short" }) + ` ${time}`;
  return d.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export class Sidebar {
  private search: HTMLInputElement;
  private list: HTMLElement;
  private footer: HTMLElement;
  /** Rows in display order, for arrow-key selection. */
  private rows: PromptMeta[] = [];
  private selected = -1;

  constructor(root: HTMLElement, private actions: SidebarActions, searchHint: string) {
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.className = "search";
    this.search.placeholder = `Search prompts  ${searchHint}`;
    this.search.spellcheck = false;
    this.search.addEventListener("input", () => {
      this.selected = this.search.value ? 0 : -1;
      this.render();
    });
    this.search.addEventListener("keydown", (e) => this.onSearchKey(e));

    this.list = document.createElement("div");
    this.list.className = "prompt-list";
    this.list.addEventListener("click", (e) => this.onListClick(e));

    this.footer = document.createElement("div");
    this.footer.className = "sidebar-footer";

    root.append(this.search, this.list, this.footer);
    onPromptsChanged(() => this.render());
    // Keep "5m ago" honest.
    setInterval(() => this.render(), 60_000);
  }

  setFolder(dir: string) {
    this.footer.textContent = `Autosaving to ${tildePath(dir)}`;
    this.footer.title = dir;
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }

  /** The prompt highlighted with the arrow keys, if the search box has focus. */
  selectedId(): string | null {
    return document.activeElement === this.search ? (this.rows[this.selected]?.id ?? null) : null;
  }

  render() {
    const terms = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [...prompts.values()]
      .filter((m) => terms.every((t) => searchText(m).includes(t)))
      .sort((a, b) => lastActivity(b) - lastActivity(a));
    const favorites = matches.filter((m) => m.starred);
    const recent = matches.filter((m) => !m.starred);
    const shownRecent = recent.slice(0, Math.max(0, MAX_ROWS - favorites.length));
    this.rows = [...favorites, ...shownRecent];
    this.selected = Math.min(this.selected, this.rows.length - 1);

    const parts: HTMLElement[] = [];
    if (favorites.length) {
      parts.push(this.heading("Favorites", favorites.length));
      favorites.forEach((m, i) => parts.push(this.row(m, i)));
    }
    if (recent.length) {
      parts.push(this.heading(favorites.length ? "Recent" : "Prompts", recent.length));
      shownRecent.forEach((m, i) => parts.push(this.row(m, favorites.length + i)));
      if (recent.length > shownRecent.length) {
        parts.push(this.note(`${recent.length - shownRecent.length} older prompts. Search to find them.`));
      }
    }
    if (!matches.length) {
      parts.push(
        this.note(
          terms.length
            ? "No prompts match."
            : "No prompts yet. Anything you write in the editor is saved here automatically.",
        ),
      );
    }
    this.list.replaceChildren(...parts);
    this.list.querySelector(".row.selected")?.scrollIntoView({ block: "nearest" });
  }

  private heading(text: string, count: number): HTMLElement {
    const h = document.createElement("div");
    h.className = "section-heading";
    h.textContent = text;
    const c = document.createElement("span");
    c.className = "count";
    c.textContent = String(count);
    h.append(c);
    return h;
  }

  private note(text: string): HTMLElement {
    const p = document.createElement("div");
    p.className = "list-note";
    p.textContent = text;
    return p;
  }

  private row(meta: PromptMeta, index: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    if (index === this.selected) row.classList.add("selected");
    if (this.actions.isOpen(meta.id)) row.classList.add("open");
    row.dataset.id = meta.id;

    const main = document.createElement("div");
    main.className = "row-main";
    const title = document.createElement("div");
    title.className = "row-title";
    title.textContent = meta.name || titleOf(meta.content) || "(empty)";
    const sub = document.createElement("div");
    sub.className = "row-sub";
    const lines = meta.content.trimEnd().split("\n").length;
    const used = meta.lastUsedMs && meta.lastUsedMs >= meta.modifiedMs ? "pasted " : "";
    sub.textContent = `${used}${relativeTime(lastActivity(meta))}${lines > 1 ? ` · ${lines} lines` : ""}`;
    main.append(title, sub);
    main.title = meta.content.slice(0, 600);

    const star = document.createElement("button");
    star.className = meta.starred ? "row-star on" : "row-star";
    star.textContent = meta.starred ? "★" : "☆";
    star.title = meta.starred ? "Unstar" : "Star (move to Favorites)";

    const paste = document.createElement("button");
    paste.className = "row-paste";
    paste.textContent = "Paste";
    paste.title = "Copy and paste into the terminal";

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(star, paste);
    row.append(main, actions);
    return row;
  }

  private onListClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>(".row")?.dataset.id;
    if (!id) return;
    const meta = prompts.get(id);
    if (target.closest(".row-star")) {
      if (meta) this.actions.star(id, !meta.starred);
    } else if (target.closest(".row-paste")) {
      this.actions.paste(id);
    } else {
      this.actions.open(id);
    }
  }

  private onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
      this.render();
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const meta = this.rows[this.selected];
      if (meta) this.actions.open(meta.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (this.search.value) {
        this.search.value = "";
        this.selected = -1;
        this.render();
      } else {
        this.actions.leave();
      }
    }
  }
}

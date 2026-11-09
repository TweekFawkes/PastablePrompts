// A row of tabs with close buttons and a "+" button, used by both panes.
// Double-clicking a tab renames it.

export interface TabItem {
  key: string;
  label: string;
  /** The full name that renaming starts from; `label` may be shortened. */
  name: string;
  tooltip?: string;
  active: boolean;
}

export interface TabBarHandlers {
  select(key: string): void;
  close(key: string): void;
  add(): void;
  /** A new name for the tab, or "" to go back to its automatic name. */
  rename(key: string, name: string): void;
}

interface Rename {
  key: string;
  input: HTMLInputElement;
  finish(save: boolean, refocus: boolean): void;
}

export class TabBar {
  private list: HTMLElement;
  private items: TabItem[] = [];
  /** The rename box, while a tab is being renamed. */
  private editing: Rename | null = null;

  constructor(host: HTMLElement, addTooltip: string, private handlers: TabBarHandlers) {
    this.list = document.createElement("div");
    this.list.className = "tabs";
    this.list.addEventListener("mousedown", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tab-rename")) return;
      // Clicking anywhere else in the bar saves a rename.
      this.editing?.finish(true, true);
      const tab = target.closest<HTMLElement>(".tab");
      if (!tab) return;
      // Keep focus where it is (the editor or terminal), not on the tab.
      e.preventDefault();
      if (e.button === 1 || target.closest(".tab-close")) {
        handlers.close(tab.dataset.key!);
      } else if (e.button === 0 && e.detail === 2) {
        // The second press of a double-click, on a tab the first press
        // already selected. Not a dblclick listener: selecting re-renders the
        // bar, so the two clicks land on different elements. And not
        // selecting again: a terminal takes focus back a moment after it's
        // selected, which would close the rename box.
        this.startRename(tab.dataset.key!);
      } else if (e.button === 0) {
        handlers.select(tab.dataset.key!);
      }
    });

    const add = document.createElement("button");
    add.className = "tab-add";
    add.textContent = "+";
    add.title = addTooltip;
    add.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.editing?.finish(true, true);
    });
    add.addEventListener("click", () => handlers.add());

    host.prepend(this.list, add);
  }

  render(items: TabItem[]) {
    this.items = items;
    if (this.editing) {
      // Rebuilding the bar would take focus from the rename box, so wait
      // until the rename is done, unless its tab has closed.
      if (items.some((i) => i.key === this.editing!.key)) return;
      this.editing = null;
    }
    this.list.replaceChildren(
      ...items.map((item) => {
        const tab = document.createElement("div");
        tab.className = item.active ? "tab active" : "tab";
        tab.dataset.key = item.key;
        if (item.tooltip) tab.title = item.tooltip;
        const label = document.createElement("span");
        label.className = "tab-label";
        label.textContent = item.label;
        const close = document.createElement("span");
        close.className = "tab-close";
        close.textContent = "×";
        tab.append(label, close);
        return tab;
      }),
    );
    this.list.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Swaps the tab's label for a text box. Enter or clicking away saves, Escape cancels. */
  private startRename(key: string) {
    const item = this.items.find((i) => i.key === key);
    const label = this.list.querySelector(`.tab[data-key="${CSS.escape(key)}"] .tab-label`);
    if (!item || !label || this.editing) return;
    const returnFocus = document.activeElement as HTMLElement | null;

    const input = document.createElement("input");
    input.className = "tab-rename";
    input.value = item.name;
    input.placeholder = "Automatic name";
    input.spellcheck = false;

    const finish = (save: boolean, refocus: boolean) => {
      if (this.editing?.input !== input) return;
      this.editing = null;
      const name = input.value.trim();
      this.render(this.items);
      if (refocus) returnFocus?.focus();
      if (save && name !== item.name) this.handlers.rename(key, name);
    };
    input.addEventListener("keydown", (e) => {
      // Keys typed here are for the box, not the editor or the shell.
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false, true);
      }
    });
    input.addEventListener("blur", () => {
      // Switching to another app keeps the box open; the box gets focus
      // back when the window does.
      if (document.hasFocus()) finish(true, false);
    });
    this.editing = { key, input, finish };

    label.replaceWith(input);
    input.focus();
    input.select();
  }
}

// A scrollbar for a terminal's history, beside the text where it's always
// visible and can be dragged like a web page's. It hides when there's nothing
// to scroll, including full-screen programs (vim, Claude Code's fullscreen
// mode), which keep their history themselves and scroll it with the wheel.
import type { Terminal } from "ghostty-web";

const MIN_THUMB_PX = 24;

export class TermScrollbar {
  private track: HTMLElement;
  private thumb: HTMLElement;
  private queued = false;

  constructor(host: HTMLElement, private term: Terminal) {
    this.track = document.createElement("div");
    this.track.className = "term-scrollbar";
    this.track.hidden = true;
    this.thumb = document.createElement("div");
    this.thumb.className = "term-thumb";
    this.track.append(this.thumb);
    host.append(this.track);

    // Keep focus in the terminal.
    this.track.addEventListener("mousedown", (e) => e.preventDefault());
    this.track.addEventListener("pointerdown", (e) => this.press(e));
    term.onScroll(() => this.update());
    term.onResize(() => this.update());
  }

  /** Redraws on the next frame, so it's cheap to call after every write. */
  update() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  private draw() {
    const term = this.term;
    const history = term.buffer.active.type === "normal" ? term.getScrollbackLength() : 0;
    this.track.hidden = history === 0;
    if (!history) return;
    const height = this.track.clientHeight;
    const thumb = Math.max(MIN_THUMB_PX, (height * term.rows) / (history + term.rows));
    const back = Math.min(term.getViewportY(), history);
    this.thumb.style.height = `${thumb}px`;
    this.thumb.style.transform = `translateY(${(height - thumb) * (1 - back / history)}px)`;
  }

  private press(e: PointerEvent) {
    if (e.button !== 0) return;
    const track = this.track.getBoundingClientRect();
    const thumb = this.thumb.getBoundingClientRect();
    if (e.target !== this.thumb) {
      // Clicking above or below the thumb pages toward the click.
      this.term.scrollPages(e.clientY < thumb.top ? -1 : 1);
      return;
    }

    const room = track.height - thumb.height;
    if (room <= 0) return;
    const startY = e.clientY;
    const startTop = thumb.top - track.top;
    this.thumb.setPointerCapture(e.pointerId);
    this.track.classList.add("dragging");
    this.thumb.onpointermove = (ev) => {
      const top = Math.min(room, Math.max(0, startTop + ev.clientY - startY));
      const back = Math.round(this.term.getScrollbackLength() * (1 - top / room));
      this.term.scrollLines(this.term.getViewportY() - back);
    };
    this.thumb.onpointerup = this.thumb.onpointercancel = () => {
      this.thumb.onpointermove = this.thumb.onpointerup = this.thumb.onpointercancel = null;
      this.track.classList.remove("dragging");
    };
  }
}

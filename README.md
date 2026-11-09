# Pastable Prompts

Write a prompt or command in an editor, read it over, then paste it into a
terminal with one keystroke. Every prompt saves itself, so you can close tabs
without thinking about it and find them again later.

- **Top third:** a Sublime-style editor with tabs. Everything you type is
  autosaved.
- **Bottom two-thirds:** terminal tabs, using Ghostty's terminal engine
  ([ghostty-web](https://github.com/coder/ghostty-web)).
- **Right sidebar:** every prompt you've written. Favorites sit on top, then
  the rest, most recently edited or pasted first.

## Copy & Paste

**Copy & Paste** (⌘↵) copies the active tab to the clipboard and pastes it
into the active terminal. **It never presses Enter**: focus moves to the
terminal so you can read the text once more and submit it yourself.

Multi-line text is sent as a *bracketed paste* whenever the program in the
terminal supports it (zsh, bash, fish, Claude Code, vim and most other
modern programs do). It arrives as one block instead of running line by line.
If the program doesn't support it, the app asks before pasting.

## Projects

Like a project in Zed, a project is a folder you're working in. Open one and
new terminals start in that folder instead of your home folder.

- **File ▸ Open Folder…** (⌘O) picks a folder and opens a terminal in it.
- The button at the right end of the terminal tabs shows the current
  project. Click it to switch to a recent project or close the project.
- The app reopens your last project when it starts, and the window title
  shows its name.
- When you switch projects, terminals that haven't received any input yet
  are replaced by one in the new folder. Terminals you've used keep running
  where they are. (Some shell prompts, such as Starship, query the terminal as
  they start. That counts as input, so those terminals are kept.)

Prompts aren't tied to a project: the sidebar always shows all of them.
Recent projects are kept in the app's settings folder
(`~/Library/Application Support/dev.pastableprompts.app/projects.json` on
macOS), not with your prompts.

## Where prompts are saved

One plain Markdown file per prompt in `~/PastablePrompts` (or
`$PASTABLE_PROMPTS_DIR`):

```
20261028-143205-fix-the-auth-bug.md
```

- The `20261028-143205` prefix is when the tab was opened. It never changes.
- The rest comes from the first line. It updates once the first line is
  finished, and again when you close the tab. If you rename the tab, it
  comes from the name instead.
- Saves happen 0.4 seconds after you stop typing, and again when you switch
  tabs, leave the window, close a tab or quit. Each save writes a temporary
  file and then replaces the real one, so a crash can't leave half a file.
- A tab closed while empty leaves no file. Clearing an old prompt and
  closing it deletes it.
- Names, stars, last-pasted times and open tabs are kept in
  `.pastable-index.json` in the same folder, so starring never renames a
  file.

Because they're plain files, you can grep them, sync them, or put the folder
in git.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘↵ | Copy & Paste the active prompt into the terminal (the highlighted one, if you're in sidebar search) |
| ⌘T | New tab in whichever pane has focus |
| ⌘N | New prompt |
| ⌘O | Open a folder as the project, with a terminal in it |
| ⌘W | Close the tab in whichever pane has focus |
| ⌘D | Duplicate the editor tab into a new tab |
| ⌘P | Search prompts (↑/↓ to choose, ↵ to open, Esc to leave) |
| ⌘B | Show/hide the sidebar |
| ⌘1 / ⌘2 | Focus the editor / terminal |
| ⌃Tab, ⌘⇧] / ⌘⇧[ | Next / previous tab |

On Windows and Linux, use Ctrl instead of ⌘. While the terminal has focus,
add Shift (Ctrl+Shift+T, Ctrl+Shift+W) so Ctrl+W and friends still reach the
shell.

Double-click a tab to rename it. ↵ saves, Esc cancels, and an empty name
goes back to the automatic one (the first line, or the shell's title).
Terminal names last until the tab closes.

Drag the bar between the editor and terminal to resize them; double-click
it to reset.

## Development

Requires [Rust](https://rustup.rs) and Node.js.

```sh
npm install
npm run tauri dev      # run the app
npm run tauri build -- --bundles app   # build "Pastable Prompts.app"
npm run tauri build    # also builds a .dmg (macOS asks to let the terminal control Finder)
cd src-tauri && cargo test
```

| Path | What's there |
| --- | --- |
| `src-tauri/src/prompts.rs` | Prompt files: naming, atomic saves, stars, session |
| `src-tauri/src/pty.rs` | One shell per terminal tab, with output streamed to the UI as raw bytes |
| `src-tauri/src/projects.rs` | The current project and recent ones |
| `src-tauri/src/lib.rs` | App setup, macOS menu, saving everything before quit |
| `src/editor.ts` | Editor tabs (CodeMirror 6) and autosave |
| `src/terminals.ts` | Terminal tabs (ghostty-web) and the bracketed-paste logic |
| `src/sidebar.ts` | Favorites, recent prompts and search |
| `src/main.ts` | Wiring, keyboard shortcuts, Copy & Paste, the project menu |

ghostty-web uses the same functions as xterm.js, so switching
`src/terminals.ts` to `@xterm/xterm` is mostly a change of import if that's
ever needed.

## License

MIT. See [LICENSE](LICENSE).

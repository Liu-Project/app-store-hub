# Markdown CommonMark Preview & Editing

[**English**](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/README.md) | [**简体中文**](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/README.zh-CN.md)

> A CommonMark-style Markdown preview with **scroll sync identical to the built-in VS Code preview**, plus familiar Markdown editing commands (bold, italic, strikethrough, lists, tasks, TOC, table formatting, …) so writing Markdown is faster.

[![Open VSX Version](https://img.shields.io/open-vsx/v/Liu-Hongcun/markdown-commonmark-preview)](https://open-vsx.org/extension/Liu-Hongcun/markdown-commonmark-preview)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/Liu-Hongcun/markdown-commonmark-preview)](https://open-vsx.org/extension/Liu-Hongcun/markdown-commonmark-preview)
[![Open VSX Rating](https://img.shields.io/open-vsx/rating/Liu-Hongcun/markdown-commonmark-preview)](https://open-vsx.org/extension/Liu-Hongcun/markdown-commonmark-preview)
[![GitHub Stars](https://img.shields.io/github/stars/Liu-Project/markdown-commonmark-preview)](https://github.com/Liu-Project/markdown-commonmark-preview)
[![License](https://img.shields.io/github/license/Liu-Project/markdown-commonmark-preview)](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/LICENSE)
[![CI](https://github.com/Liu-Project/markdown-commonmark-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Liu-Project/markdown-commonmark-preview/actions/workflows/ci.yml)

> If this extension helps you, please give it a ⭐ on GitHub — your support keeps this project alive!

- Standalone Webview preview that follows the VS Code light / dark theme with no flicker
- Two-way scroll sync between editor and preview, precise and smooth
- Math (KaTeX), mermaid diagrams, syntax highlighting and task lists out of the box
- Common Markdown editing commands with shortcuts matching mainstream editors

---

## Why this extension?

VS Code's built-in Markdown preview is already great. This extension keeps **the exact same preview feel** while adding ready-to-use enhancements:

| Capability | This extension | VS Code built-in | Notes |
|------------|:--------------:|:----------------:|-------|
| Two-way scroll sync | ✅ | ✅ | Line-level interpolation, per-line mapping inside code blocks |
| KaTeX math | ✅ | ⚠️ needs plugin | `$...$` / `$$...$$` out of the box |
| mermaid diagrams | ✅ | ⚠️ needs plugin | flowchart / sequence / gantt / class / state / pie / er / journey / gitGraph / mindmap / timeline |
| Syntax highlighting | ✅ | ✅ | highlight.js, follows theme |
| Task lists | ✅ | ✅ | Checkable |
| Preview search | ✅ | ✅ | `Ctrl+F` find widget |
| Table formatting | ✅ | ❌ | One-click alignment |
| TOC create / update | ✅ | ❌ | Anchor jumps |
| List / task / math editing commands | ✅ | ❌ | Keyboard shortcuts |
| Export to HTML | ✅ | ❌ | With theme, optional Base64 images |

**Typical use cases**: technical documentation, math-heavy notes, architecture designs with mermaid diagrams, blog / newsletter writing.

---

## Features

### Preview

- Theme follows the built-in VS Code Markdown preview (`--vscode-*` variables); light / dark auto-switch with no flicker.
- Two-way scroll sync identical to the built-in preview: line-level interpolation, per-line mapping inside code blocks, 50ms throttled continuous following, anti-loop suppression in both directions.
- Scroll sync only kicks in when preview and editor are side-by-side (no sync when stacked); multiple side-by-side windows of the same file all follow together.
- Opening the preview auto-jumps to the editor's current line; positioning happens after images load to avoid drift.
- Preview search: press `Ctrl+F` (`Cmd+F` on macOS) to open a find widget identical to the built-in preview — next / previous, match highlight and count, `Enter` / `Shift+Enter` to switch, `Esc` to close.
- The preview tab has a dedicated icon (document + magnifier) to distinguish it from plain Markdown tabs.
- Supported extensions: `.md` `.markdown` `.mdx` `.mdown` `.mkd` `.rmd` `.qmd` `.txt`.

### Editing commands

| Command | Default keybinding | Description |
|---------|-------------------|-------------|
| Toggle Bold | `Ctrl+B` | Bold `**` / `__` |
| Toggle Italic | `Ctrl+I` | Italic `*` / `_` |
| Toggle Strikethrough | `Alt+S` | Strikethrough `~~` |
| Toggle Code Span | `` Ctrl+` `` | Inline code `` ` `` |
| Toggle Code Block | - | Code block |
| Toggle Math | `Ctrl+M` | Inline / block math |
| Toggle List | - | Toggle list item `-` |
| Toggle Task List | `Alt+C` | Check / uncheck task |
| Create / Update TOC | - | Generate / update table of contents |
| Format Table | - | Align table formatting |
| Print to HTML | - | Export HTML (with theme) |

> On macOS use `Cmd` instead of `Ctrl`.

### Rendering capabilities

- Math (KaTeX via `markdown-it-texmath`)
- Diagrams (mermaid: flowchart / sequence / gantt / class / state / pie / er / journey / gitGraph / mindmap / timeline)
- Syntax highlighting (highlight.js, follows theme)
- Task lists (`markdown-it-task-lists`)

---

## Screenshots

![Light theme preview](http://127.0.0.1:3000/assets/Liu-Hongcun.markdown-commonmark-preview/screenshots/light.png)

![Dark theme preview](http://127.0.0.1:3000/assets/Liu-Hongcun.markdown-commonmark-preview/screenshots/dark.png)

![Editor and preview sync](http://127.0.0.1:3000/assets/Liu-Hongcun.markdown-commonmark-preview/screenshots/sync.png)

---

## Quick start

### Install

**Option 1: Install from Open VSX (recommended, works with VSCodium / Cursor / etc.)**

```
code --install-extension Liu-Hongcun.markdown-commonmark-preview
```

Or search `Markdown CommonMark Preview & Editing` in the Extensions view.

**Option 2: Install from GitHub Releases**

Download the `.vsix` from the latest [Release](https://github.com/Liu-Project/markdown-commonmark-preview/releases), then in the Extensions view → `...` → **Install from VSIX**.

**Option 3: Build from source (development)**

```
git clone https://github.com/Liu-Project/markdown-commonmark-preview.git
cd markdown-commonmark-preview
npm install
npm run compile
code --install-extension markdown-commonmark-preview-*.vsix
```

### Open the preview

| Way | Action |
|-----|--------|
| Shortcut | `Ctrl+K K` (`Cmd+K K` on macOS) |
| Explorer context menu | Right-click a Markdown file → `Preview` |
| Editor title bar | Click the preview icon |
| Editor context menu | Right-click → `Preview` |
| Open With | `Open With…` → `Markdown CommonMark - Edit / Preview` |

Where the preview opens:

- `Ctrl+K K` and the title-bar icon: open the preview **side-by-side** to the right of the current window.
- Explorer / editor tab context menu: open the preview **stacked** in the current window (no side-by-side popup).
- If a preview of the file already exists in the target window, it is **activated instead of duplicated** (same as the built-in preview).

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `markdown-commonmark-preview.bold.indicator` | `**` | Bold marker |
| `markdown-commonmark-preview.italic.indicator` | `*` | Italic marker |
| `markdown-commonmark-preview.toc.levels` | `1..6` | TOC heading levels |
| `markdown-commonmark-preview.tableFormatter.enabled` | `true` | Table formatter on/off |

See the full list in Settings (`Ctrl+,` → search `markdown-commonmark-preview`).

---

## Known limitations

- The preview is a standalone Webview (not the built-in overlay) and does not participate in the built-in `markdown.*` settings.
- Code folding (DETAILS), diff highlighting and `scrollProgress` restore are not implemented yet (they do not affect normal use).

---

## Contributing

Bug reports and feature requests are welcome via [Issues](https://github.com/Liu-Project/markdown-commonmark-preview/issues), and pull requests are always appreciated. See [CONTRIBUTING.md](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/CONTRIBUTING.md).

If you like this project:

- ⭐ Star it on [GitHub](https://github.com/Liu-Project/markdown-commonmark-preview)
- 📣 Share it with friends who write Markdown
- 🐛 Report problems via [Issues](https://github.com/Liu-Project/markdown-commonmark-preview/issues)

---

## Release notes

See [CHANGELOG.md](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/CHANGELOG.md) for the full changelog.

- **0.2.11**: Unknown/custom XML tags in the preview (e.g. `<Schedules>`, `<PartitionWindow/>`) are now shown as low-contrast grey text (Typora-style), keeping tag name and attributes visible instead of being swallowed by the browser; line breaks and indentation are preserved and normal text is unaffected. Standard HTML tags (`<img>`, `<table>`, `<div>`, ...) still render for real. Applies to both the custom-editor preview and the built-in Markdown preview (Ctrl+K V).
- **0.2.10**: Fixed the preview not updating while editing — the preview now refreshes immediately when you edit the Markdown (including removing list items), matching the built-in VS Code Markdown preview.
- **0.2.9**: Scroll sync only in side-by-side windows; all side-by-side windows of the same file follow together; context-menu preview opens in place and activates an existing preview; dedicated preview tab icon.
- **0.2.7**: Preview search (`Ctrl+F` / `Cmd+F`) with a find widget identical to the built-in preview.
- **0.2.6**: Fixed activation error — color ids with illegal hyphens renamed to letters/digits/dots only.
- **0.2.5**: First release: CommonMark-style preview, two-way scroll sync and common editing commands.

---

## License & third-party notices

Released under the [MIT License](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/LICENSE).

Rendering is built on open-source KaTeX / mermaid / highlight.js / markdown-it; third-party licenses are listed in [THIRD_PARTY_NOTICES.md](https://github.com/Liu-Project/markdown-commonmark-preview/blob/HEAD/THIRD_PARTY_NOTICES.md).

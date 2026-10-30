<div align="center">

# App Store Hub

**Browse, search, install, update and uninstall VS Code extensions directly inside your editor** — with multiple sources, freely switchable, out-of-the-box support for the official VS Code Marketplace and Open VSX.

<small>Requires VS Code `1.77.0+`</small>

<br/>

[![Open VSX Version](https://img.shields.io/open-vsx/v/Liu-Hongcun/appstore-hub?label=Open%20VSX)](https://open-vsx.org/extension/Liu-Hongcun/appstore-hub)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/Liu-Hongcun/appstore-hub)](https://open-vsx.org/extension/Liu-Hongcun/appstore-hub)
[![GitHub Stars](https://img.shields.io/github/stars/Liu-Project/app-store-hub?style=social)](https://github.com/Liu-Project/app-store-hub)
[![CI](https://img.shields.io/github/actions/workflow/status/Liu-Project/app-store-hub/ci.yml?branch=master&label=CI)](https://github.com/Liu-Project/app-store-hub/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[English](./README.en.md) · [简体中文](./README.md)

</div>

---

## Screenshot

![App Store Hub extension list](https://cdn.jsdelivr.net/gh/Liu-Project/app-store-hub@master/media/screenshot.png)

## Features

- **Visual extension store** — one click from the Activity Bar, browse extensions in a card grid with debounced search, category filters and pagination
- **Standalone detail view** — open extension details in an editor tab (version / author / installs / rating / description), with README and changelog rendered inline
- **Full lifecycle management** — install, uninstall and update extensions, and even pick a specific version to install
- **Multiple sources** — switch sources from a dropdown at any time, add / remove sources right in the UI; each source talks to its own backend service
- **Bilingual UI** — automatically follows your VS Code display language, or explicitly set `zh-cn` / `en` in settings
- **Standard Gallery protocol** — compatible with the VS Code `extensionsGallery` protocol (`/extensionquery` / `vspackage` / `asset`), so you can plug in any backend that implements it
- **Network resilience** — native socket connections, automatic retries, concurrent racing, configurable proxy and timeouts; external screenshots are downloaded through the proxy and re-served inline

## Getting Started

- **Open it**: click the 「App Store Hub」 icon in the Activity Bar, or run *App Store Hub: Open App Store Hub* from the Command Palette
- **Switch sources**: pick one from the dropdown at the top; click 「Sources」 to add / remove / set the current source — configuration is persisted to VS Code settings
- **Install mode**: `auto` (default — actually invokes VS Code's extension installer) or `manual` (records state only)

**Preset sources**

| Source | URL |
| --- | --- |
| VS Code Marketplace | `https://marketplace.visualstudio.com/_apis/public/gallery` |
| Open VSX | `https://open-vsx.org/vscode/gallery` |
| Local dev source | `http://127.0.0.1:3000` |

## Configuration

Configure under the `appStoreHub.*` prefix in VS Code settings (`Ctrl+,`):

| Setting | Default | Description |
| --- | --- | --- |
| `appStoreHub.language` | `auto` | UI language: `auto` (follows VS Code display language, `zh` prefix → Chinese), `zh-cn` (Simplified Chinese), `en` (English) |
| `appStoreHub.sources` | 3 presets | List of sources `[{ "label": "...", "url": "http(s)://..." }]`; set `concurrent` to enable connection racing |
| `appStoreHub.activeSource` | VS Code Marketplace | URL of the currently active source |
| `appStoreHub.installMode` | `auto` | Install mode: `auto` / `manual` |
| `appStoreHub.proxy` | empty | HTTP/HTTPS proxy; falls back to `http.proxy` then `https_proxy` / `http_proxy` env vars |
| `appStoreHub.retry` | `4` | Automatic retry count on connection failure (writes are never retried) |
| `appStoreHub.connTimeout` | `20000` | Connection timeout per request (ms) |
| `appStoreHub.debug` | `true` | Debug logging toggle (request URL, proxy, latency, retries and errors) |

## FAQ

**Stuck on "Loading app list..."?**
The current source is unreachable. On restricted networks, configure `appStoreHub.proxy` — note that when VS Code is launched from a desktop icon the extension host does not inherit proxy variables exported in your terminal, so configure the proxy explicitly in settings.

**Can I point it at my own extension store?**
Yes. Any backend implementing the VS Code `extensionsGallery` protocol can be added as a source.

## Development

```bash
npm install     # install dependencies
npm run compile # compile TypeScript
npm test        # run unit tests
npm run package # build the .vsix
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contribution guide.

## License

[MIT](./LICENSE) · Changelog: [CHANGELOG.md](./CHANGELOG.md)

**Credits**

- [marked](https://github.com/markedjs/marked) (MIT)
- [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0)
- [marked-gfm-heading-id](https://github.com/markedjs/marked-gfm-heading-id) (MIT)

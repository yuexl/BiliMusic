# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

BiliMusic is an Electron + React 19 desktop music player that turns Bilibili videos into a music library (Apple Music-style UI). It also ships a HarmonyOS PC port. Requires Node.js >= 20 and npm. Code comments and UI strings are in Chinese.

## Commands

All scripts are in `package.json`; there is no lint config, no test runner, and no test files. `npx tsc --noEmit` (tsconfig: `strict`, `noUnusedLocals`, `noUnusedParameters`) is the only static check available — there is no single-test command.

| Command | What it does |
| --- | --- |
| `npm install` / `npm ci` | Install deps (`npm ci` is what CI uses) |
| `npm run dev` | Vite dev server on :5173; `vite-plugin-electron` also builds `electron/main.ts` and launches Electron with `VITE_DEV_SERVER_URL` set (HMR + DevTools). This is the normal dev loop. |
| `npm run build` | `vite build` + `copy-preload`. Produces `dist/` (renderer) and `dist-electron/` (bundled `main.js`); copies `electron/preload.cjs`, `icon.png`, `tray.png` verbatim into `dist-electron/`. |
| `npm run preview` | Preview the built renderer only |
| `npm run electron:start` | `npm run build` then `electron .` (runs the built app) |
| `npm run electron:build` | `npm run build` then `electron-builder` → `release/` (Win NSIS, mac DMG/ZIP, Linux AppImage/DEB) |
| `npm run harmony:prepare` | `npm run build` then `scripts/prepare-harmony.mjs`: copies `dist/` + `dist-electron/` + a minimal `package.json` into `platform/HarmonyOS/web_engine/src/main/resources/resfile/resources/app` |
| `npm run harmony:build` | `harmony:prepare` then `scripts/build-harmony.mjs` (tries `hvigor`/`HVIGOR_BIN`; otherwise build HAP in DevEco Studio) |
| `npm run build:ota` | `npm run build` then `scripts/build-ota.mjs`: packs `dist/` into `release/ota/renderer-<version>.asar` + `ota.json` (sha512, `minShellVersion`, from `OTA_MIN_SHELL`/`OTA_NOTES`) |
| `npx tsc --noEmit` | Type-check (`noEmit: true` in tsconfig) |

Before submitting changes, at minimum run `npm run build`; if the HarmonyOS project changed, also `npm run harmony:prepare`.

## Architecture (big picture)

### Three layers + the HarmonyOS port

```
src/** (React renderer, HashRouter)
   └─ window.electronAPI  ← electron/preload.cjs (contextBridge)
        └─ IPC            ← electron/*.ts (main process)
                              └─ platform/HarmonyOS (separate ArkTS/ETS Electron-port project)
```

`vite.config.ts` uses `@vitejs/plugin-react`, `@tailwindcss/vite`, and `vite-plugin-electron` (entry `electron/main.ts` → `dist-electron/main.js`). Alias `@` → `src`. `base: './'` + `HashRouter` (`src/main.tsx`) so the renderer works from `app://`/`file://`. `index.html` loads `/src/main.tsx`.

**`preload.cjs` is CommonJS and is copied verbatim, never bundled.** When adding an IPC API you must touch three places: `electron/preload.cjs` (expose), a `register*Handlers()` module or `electron/main.ts` (`ipcMain.handle`/`on`), and `src/types/electron.d.ts` (`Window.electronAPI` typing). All channel names are string literals shared across these files.

### Production loading: custom `app://` protocol

`electron/main.ts` registers `app` as a privileged scheme **before** `app.whenReady()` and handles it in the ready hook, mapping `app://local/index.html` → `getActiveRendererRoot()`. This exists because `file://` gives ESM module scripts an opaque origin and CORS blocks them. Dev mode instead loads `process.env.VITE_DEV_SERVER_URL`. The same `app://` handler is what makes OTA renderer hot patches possible.

### Bilibili requests: renderer fetch, not the IPC proxy (important, non-obvious)

`electron/biliApi.ts` registers `bili:*` IPC handlers and `services/api.ts` looks like an adapter, but most read APIs (search, detail, playurl, recommend, ranking) actually go through **renderer-side browser `fetch`** in `src/services/bilibiliApi.ts` with `credentials: 'include'`. Main-process `net.fetch` gets Bilibili's `-352` anti-scraping block. To make the browser fetch work, `setupBiliHeaders()` in `main.ts` must inject `Referer`/`Origin: https://www.bilibili.com` and CORS response headers — **all header logic is in one `onBeforeSendHeaders` listener**, because Electron allows only one listener per session event and a second would silently override the first (audio CDN then 403s). Keep it that way.

IPC `biliApi` remains the path for: QR login (`qrGenerate`/`qrPoll`/`getCookies`/`logout`), `downloadAudio` (writes to the download dir persisted by the main process in `userData/download-dir.json`, falling back to `userData/downloads`; Settings mirrors the value into `AppSettings` for display), and `extractAudio` (picks the highest-bandwidth DASH audio stream). Playback is a single `HTMLAudioElement` owned by `src/contexts/PlayerContext.tsx` (~747 lines): queue, current track, volume, progress, shuffle/repeat, autoplay, and tray state sync. Downloaded tracks are played from disk first via `app://local/__download__/<encoded-abs-path>` (the `app://` handler bridges local audio files because a secure origin cannot load `file://`), falling back to the online stream if the file is missing. That handler **must** set an explicit `Content-Type` and handle `Range` requests with 206 responses — Chromium's media element always sends `Range: bytes=0-` and picks a demuxer from the MIME type; a plain `net.fetch(file://)` returns neither, which silently breaks ordinary mp3/mp4 (fMP4 `.m4a` happens to work).

### Lyrics

`electron/lyricsApi.ts` proxies `oiapi.net` QQ Music lyric search/get over `net.fetch` (9s timeout). All intelligence is in renderer `src/services/lyrics.ts`: Bilibili-title noise removal, candidate keyword generation, similarity scoring, LRC parsing, and caching. `src/hooks/useLyrics.ts` wraps it.

### State, persistence, and WebDAV sync (newer than README)

- Global state: `AuthProvider > PlayerProvider > NowPlayingProvider > AddToPlaylistProvider` in `src/App.tsx`; routes/pages in `src/pages/`, layout + player UI in `src/components/`, design system in `src/styles/index.css` (Tailwind v4 + custom Apple-Music glass styles).
- All local state (settings, theme, recent, favorites, playlists, tombstones, downloads, player/auth state) goes through `src/utils/persistentStorage.ts`: `window.electronAPI.persistentStorage` → main-process IPC → `userData/renderer-persistent-store.json`. The main-process file is the authority on **every** platform (not just HarmonyOS); `localStorage` is only a fast mirror. `readStoredItem()` prefers the main-process value, back-fills `localStorage`, and migrates existing `localStorage` values on first run after an upgrade. Only the disposable lyrics cache in `src/services/lyrics.ts` still uses raw `localStorage`.
- WebDAV sync: `electron/webdav.ts` is deliberately a **dumb transport** — Basic-auth GET/PUT/MKCOL with ETag, credentials encrypted via `safeStorage` into `userData/webdav.json`. It never touches business data. All merge/conflict logic is in renderer `src/utils/sync.ts`: tombstones for deletes, per-id newest-version merge, optimistic concurrency (`If-Match`, retry on HTTP 412), `runSync`/`forceUpload`/`forceDownload`. `src/hooks/useAutoSync.ts` triggers startup + debounced (5s) + periodic (15min) syncs only when WebDAV is configured, and ignores `CHANGED` events while `isSyncing()` to avoid a loop. Sync data file: `sync.json` under the DAV `bilimusic/` collection.

### OTA updates (newer than README)

Manifest-driven from `https://github.com/HanversionOvO/BiliMusic/releases/latest/download/ota.json`. Two update paths, both emitting a unified `updater:event` via `electron/updaterBus.ts` (typed `UpdaterEvent` in `electron.d.ts`, consumed in `src/pages/Settings.tsx`):

1. **Renderer hot patch** (all platforms incl. mac/HarmonyOS): `electron/otaUpdater.ts` downloads `renderer-<v>.asar`, verifies sha512, stages into `userData/ota`, and `app://` serves from `getActiveRendererRoot()`. A `notifyRendererReady()` heartbeat from `src/App.tsx` marks the patch verified; an unverified patch is rolled back + blacklisted at next boot (`bootReconcile`). `minShellVersion` gates patches on old shells.
2. **Full shell update**: `electron/updater.ts` uses `electron-updater` on Win/Linux only, **dynamically imported** so `main.js` never fails to load on HarmonyOS (no `node_modules`). Unsigned mac and HarmonyOS fall back to opening the Releases page.

`vite.config.ts` externalizes `electron`, `electron-updater`, and Node builtins from the main bundle for the same reason. `initUpdates()` must run before `createWindow()` so `bootReconcile` fixes the active renderer root first. `.github/workflows/build.yml` (triggered by `v*` tags) builds per-OS installers and publishes `latest*.yml`, `ota.json`, and the asar (Linux job produces the OTA bundle once).

### Window / tray / platform differences

`main.ts`: frameless `BrowserWindow`, close → `hideToTray` (not quit), custom tray popup is a separate `BrowserWindow` with inline HTML (`nodeIntegration: true`, `contextIsolation: false`) driven by `tray:state`/`tray:command`. Platform branch is `process.platform === 'openharmony'`: uses `tray.png`, disables the popup instead of showing a black window, creates tray before window, and toggles native three-key buttons via `setWindowButtonVisibility` + a `__BILIMUSIC_WINDOW_BUTTONS__:` title sentinel. Remote debugging port `17689` is always enabled for dev. `platform/HarmonyOS` is an independent DevEco Studio / Hvigor (`.ets`, `module.json5`) project — do not apply desktop JS tooling to it.

## Key files

| Path | Role |
| --- | --- |
| `vite.config.ts`, `package.json` | Build wiring, all npm scripts, electron-builder config |
| `electron/main.ts` | Window/tray lifecycle, `app://` protocol, Bili CORS header injection, IPC wiring |
| `electron/preload.cjs` | The entire `window.electronAPI` surface (copied verbatim at build) |
| `src/types/electron.d.ts` | Type contract for the bridge + `UpdaterEvent` |
| `electron/otaUpdater.ts`, `updater.ts`, `updaterBus.ts` | Renderer hot patch, full-shell updater, unified event bus |
| `electron/webdav.ts`, `src/utils/sync.ts`, `src/hooks/useAutoSync.ts` | DAV transport, merge logic, auto-sync triggers |
| `electron/biliApi.ts`, `lyricsApi.ts` | IPC API proxies |
| `src/services/api.ts`, `bilibiliApi.ts`, `lyrics.ts` | Adapter, renderer-side Bili fetch, title cleaning/lyrics |
| `src/contexts/PlayerContext.tsx` | Playback engine + queue |
| `src/utils/storage.ts`, `persistentStorage.ts` | Library/setting accessors + main-process durable store bridge (all platforms) |
| `src/utils/downloads.ts`, `src/pages/Downloads.tsx`, `src/components/TrackActions.tsx` | Download records/orchestration, scanning pre-existing audio files in the download dir, downloads page, per-row download button |
| `scripts/*.mjs`, `.github/workflows/build.yml` | HarmonyOS prep/build, OTA packaging, release CI |

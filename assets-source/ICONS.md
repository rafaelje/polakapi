# App Icons

How the polakapi app icon is authored, rasterized, and wired into Tauri.

## Files in this directory

| File | Purpose |
| --- | --- |
| `source.svg` | Hand-authored vector source. Edit this when you want to change the logo. |
| `source.svg.png` | 1024×1024 PNG rasterized from `source.svg`. Input for `tauri icon`. |
| `ICONS.md` | This doc. |

Everything in `src-tauri/icons/` (`.icns`, `.ico`, the platform PNGs, the iOS/Android sets) is **generated** — never edit those by hand.

## Design — Apple HIG geometry

The SVG is a 1024×1024 canvas that follows the macOS app icon template:

- **Background shape**: 824×824 rounded square centered in the canvas (100px transparent margin on every side). This is what gives the icon the same visual size as built-in macOS apps in the Dock — without the margin the icon looks oversized next to its neighbors.
- **Corner radius**: `rx="185"` on the 824 shape. Approximates Apple's continuous-corner squircle closely enough for an icon at Dock sizes.
- **Glyph**: white "P" scaled to ~70% of the canvas and centered inside the shape, giving balanced padding around it (comparable to the chat-bubble inside the WhatsApp icon).

The glyph is drawn as SVG **paths**, not as `<text>`, because `rsvg-convert` (see below) cannot find macOS system fonts via fontconfig and would otherwise render empty text. Paths also guarantee identical rendering on any machine.

## Regenerating the icons

```bash
# From the project root:
rsvg-convert -w 1024 -h 1024 assets-source/source.svg -o assets-source/source.svg.png
pnpm tauri icon assets-source/source.svg.png
```

`pnpm tauri icon` overwrites every file in `src-tauri/icons/` from the single PNG you pass.

If `rsvg-convert` is missing:

```bash
brew install librsvg
```

## Rasterizer gotcha — do NOT use `qlmanage`

macOS ships with `qlmanage -t` which can also produce a PNG from an SVG, but it **inverts the alpha**: white pixels of the SVG become opaque white pixels, and the glyph shape becomes a transparent hole. The Dock then shows a white square with a P-shaped cutout — not what you want.

Always rasterize with `rsvg-convert`. It honors the SVG's transparency exactly.

## Refreshing the Dock after a change

The dev watcher rebuilds the binary when files under `src-tauri/icons/` change, so the icon embedded into the binary is fresh after `pnpm tauri icon` finishes. But macOS aggressively caches Dock icons. If the running app still shows the old icon:

```bash
killall Dock
```

If even that does not help, kill the dev server, run `cargo clean -p polakapi` in `src-tauri/` (forces `tauri::generate_context!()` to re-embed the icon resource), and start `pnpm tauri dev` again. `cargo clean -p polakapi` removes the polakapi crate's full dep graph too — first rebuild after a clean takes 1–3 minutes.

## Where the icon is referenced

- `src-tauri/tauri.conf.json` → `bundle.icon` lists the PNG / `.icns` / `.ico` files Tauri ships in release builds. In dev mode, the first PNG in that list is embedded as the window/Dock icon by the `tauri::generate_context!()` macro.
- `src-tauri/Cargo.toml` build script (`tauri-build`) re-runs when the referenced icon files change, which is how the rebuild gets triggered.

# Arunika Cover

[![make.fun](https://make.fun/badge/gta6-cover-art-01.svg)](https://make.fun/bounty/gta6-cover-art-01)
[![rank](https://make.fun/badge/gta6-cover-art-01/kamelia-nirmala/arunika-cover/rank.svg)](https://make.fun/bounty/gta6-cover-art-01)
[![reward](https://make.fun/badge/gta6-cover-art-01/kamelia-nirmala/arunika-cover/reward.svg)](https://make.fun/bounty/gta6-cover-art-01)

An offline web app that turns your photos and a caption into sun-soaked cover art: multi-panel layouts, heavy poster type, and a sunset/neon colour grade, exported as a PNG at 1080 × 1080, 1080 × 1350 or 1920 × 1080.

Load one or more photos, pick a layout — a hero panel over a strip, a grid, a comic page, or a single full-bleed hero — then drop a title and subtitle on top. Each panel keeps its own crop, zoom and pan, so the same shot can be framed twice; the grade adds warmth, contrast and saturation on top of the whole cover. Everything runs in the browser: no upload, no network request, no build step, and no fonts or artwork from any game — the typeface and every sample image here were made for this entry.

## Use

Serve `app/` locally and open it in a desktop browser:

```sh
node serve.ts
# open http://localhost:8080
```

Pick a photo (or one of the two samples), choose a layout and a size, tune the grade and caption, then hit **Export** to save the PNG to your downloads folder.

## Tech

- Plain static files: `app/index.html` and its ES modules, a canvas renderer, no library and no network requests.
- All art, type and sample photos are original and generated for this entry.
- `main.ts` (Node 22, standard library only) checks `screenshots/` (3 or 4 files, each ≤ 256 KiB) and `app/index.html` (≤ 1 MiB), copies `app/` and `screenshots/` to `/output`, and writes `dossier.json`.

## License

MIT — see [LICENSE](LICENSE).

# Memento

Choose a few photos. Make a little movie. Watch it.

This is a personal demo. The movie is the product: pick photos, tap **Make my movie**, and watch a short film with gentle music. Voice recording, memoir books and accounts are deliberately left out.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # scene-plan tests
npm run build      # typecheck + production build into dist/
```

No API keys or external services are needed. Fonts are bundled, so nothing is fetched from a font host.

To publish a single-page copy as a claude.ai Artifact: `npm run build && npm run artifact`, then publish `artifact/index.html` with the `samples/` and `audio/` folders beside it.

## How it works

| File | Job |
| --- | --- |
| `src/scene.ts` | The scene plan: photo order, durations, crossfades, zoom, title card. Pure functions, no DOM. The browser preview draws it today and the MP4 renderer should read the same plan. |
| `src/render.ts` | Draws one frame of a plan on a 1280x720 canvas. Whole photographs are kept (never cropped), over a soft blurred copy of the same photo. |
| `src/player.ts` | Real-time playback, pause, seek and loop. |
| `src/music.ts` | Soundtrack through Web Audio, with fades. |
| `src/photos.ts` | Decodes photos one at a time, respects EXIF orientation, makes 1280 px working copies and thumbnails, reports each failed file. |
| `src/main.ts` | The three screens, the Arrange and Edit sheets, and the Download notice. |
| `tools/make_music.py` | Synthesizes the two soundtracks (needs numpy, scipy, ffmpeg). |

Defaults: photo order as selected, Gentle piano, restrained motion (photos breathe between 95.5% and 100% of their fitted size), soft crossfades, and a length chosen from the photo count. Relaxed pace is about 30 to 60 seconds for 5 to 12 photos. Up to 20 photos, 40 MB each.

## Preview versus MP4

What you watch is a **browser preview** drawn live on a canvas. It is not a video file. **MP4 export is not built yet**, and the Download button says so rather than pretending. The planned route is a small server-side FFmpeg renderer that reads the same scene plan (H.264 and AAC, 720p). It needs a host that can run the ffmpeg binary, which rules out plain serverless functions.

## Privacy

Everything stays in the browser today. Photos are decoded locally and held in memory, so refreshing the page clears your work. Nothing is uploaded and nothing is logged. When server-side export is added, photos will have to be uploaded for rendering, and that needs short retention and access protection.

## Tested and not tested

Tested in headless desktop Chrome at 390x844, 320x568, 844x390 and 1280x800: all screens, the sample movie, your own photos including an EXIF-rotated one, a 12-megapixel photo, files that are not photos, the 20-photo cap, Arrange, Edit, the Download notice, reduced motion, no horizontal scroll, and 44 px touch targets. The audio engine was checked for decode, start and pause/resume.

Not tested: **Safari on a real iPhone** (HEIC pickup, audio with the ring switch off, canvas performance), Firefox, Android. Nobody has listened to the music tracks yet beyond level checks.

## Credits

See `public/CREDITS.md`. Sample photos are public domain or Creative Commons Attribution 2.0. The music is original and synthesized in `tools/make_music.py`.

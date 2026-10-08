# Memento

Choose a few photos and clips. Make a little movie. Watch it.

This is a personal demo. The movie is the product: pick photos and videos, tap **Make my movie**, and watch a short film with gentle music. Clips keep their own sound, and the music lowers underneath them. Voice recording, memoir books and accounts are deliberately left out.

## Run it

```bash
npm install
npm run dev        # the app only, http://localhost:5173 (browser preview)
npm test           # scene plan, container reader, and an end-to-end MP4 render
npm run build      # typecheck + production build into dist/
npm start          # the app AND the MP4 renderer, http://127.0.0.1:8787  (needs ffmpeg)
```

No API keys or external services are needed. Fonts are bundled, so nothing is fetched from a font host.

To use the MP4 download while developing, run `npm start` in a second terminal; `npm run dev` forwards `/api` to it.

**Try it on your iPhone.** Build, then start the server on your network: `npm run build && HOST=0.0.0.0 npm start`, and open `http://<your computer's address>:8787` in Safari on the same Wi-Fi. This is the way to check HEVC clips, clip sound and MP4 download on a real phone. Anyone on that network can reach the server while it runs, so stop it afterwards.

To publish a single-page copy as a claude.ai Artifact: `npm run build && npm run artifact`, then publish `artifact/index.html` with the `samples/` and `audio/` folders beside it. That copy is the browser preview only; it has no renderer, so its Download button says so.

## What goes in

Up to **30 photos and clips** in one sequence (at most 10 clips, because phones keep a video decoder alive per clip). Photos up to 40 MB, clips up to 800 MB. Photos, clips and the sequence are held in memory only.

- **Clips use a short excerpt**: about 6 seconds, starting a little way in (4.5 s with the quicker pace). A clip shorter than that is used whole. Tap any tile to preview it; for a clip, **Starts at** and **Length** sliders trim it and **Let Memento choose** goes back to automatic. This is a fixed rule, not a search for the best moment.
- **Orientation is kept.** Portrait clips and photos are never rotated wrongly or stretched; margins are filled with a blurred, darkened copy of the same picture.
- **Sound.** Each clip's own sound is on by default and the music drops to about 18% under it. A speaker button on the watch screen mutes everything. Edit can switch clip sound off.
- **Unsupported files** are named with a reason (for example HEVC in a browser that can't play it) and everything else still goes in.

## How it works

| File | Job |
| --- | --- |
| `src/scene.ts` | The scene plan: item order, excerpts, durations, crossfades, zoom, title card, and the music-ducking curve. Pure functions, no DOM. **The preview and the MP4 renderer both read this one file.** |
| `src/render.ts` | Draws one frame of a plan on a 1280x720 canvas, including live video frames. Whole pictures are kept (never cropped). |
| `src/player.ts` | Real-time playback, pause, seek and loop. Keeps each clip's `<video>` on the movie's clock. |
| `src/music.ts` | Soundtrack through Web Audio, with fades, ducking and mute. |
| `src/media.ts` | Opens photos and clips one at a time: orientation, 1280 px working copies, thumbnails, a MOV/MP4/WebM header reader (codec, audio track), per-file failure reasons. |
| `src/exporter.ts` | Sends the movie to the renderer and reports real progress. |
| `src/main.ts` | The screens, the item sheet with trim, Arrange, Edit and Download. |
| `server/render.ts` | FFmpeg renderer: one H.264 segment per scene, then crossfades, fades to black and the audio mix in one pass. |
| `server/index.ts` | The small HTTP server (uploads, status, download) that also serves `dist/`. |
| `server/cli.ts` | Render from files on disk: `node server/cli.ts out.mp4 a.jpg b.mov c.jpg` |
| `tools/make_music.py` | Synthesizes the two soundtracks (needs numpy, scipy, ffmpeg). |

## Preview versus MP4

What you watch is a **browser preview** drawn live on a canvas. It is not a video file.

The **MP4 is made by FFmpeg** from the same scene plan: 1280x720, 30 fps, H.264 High + AAC 192k, with the real clip footage and sound, the title card the browser drew, the same zoom, crossfades and music ducking. The page uploads your photos (as the 1280 px copies the preview uses) and the original clip files to the renderer, shows real progress (bytes sent, then FFmpeg's own output time), and offers **Save MP4**.

It is not frame-identical to the preview: scaling filters differ slightly, a clip's volume ramps are exact in the MP4 but ignored by iPhone Safari in the preview (it plays clips at full level), and rendering takes about as long as the film (about 35 s for a 34 s film on a 2-core machine). The renderer needs the `ffmpeg` and `ffprobe` binaries, which rules out plain serverless functions.

HDR iPhone clips (HLG) are tone-mapped to ordinary video in the MP4. Variable frame rate clips are made constant 30 fps.

## iPhone formats

- **iPhone Safari** plays MOV and HEVC clips itself, so the preview needs no conversion there.
- **Browsers without HEVC** (some Chrome, Edge and Firefox setups) can't preview iPhone clips by default. Memento reads the file header, says it is HEVC, and doesn't add it. Choosing **Settings › Camera › Formats › Most Compatible** on the iPhone records H.264 instead.
- **The MP4 renderer decodes anything FFmpeg can**, including HEVC, H.264 MOV, rotated portrait clips and HLG, so a clip that plays in the browser always exports.
- There is no in-browser conversion of unsupported clips.

## Privacy

Opening photos and clips happens in the browser; nothing is uploaded until you choose **Make MP4**. Then the files go to the renderer you are connected to (your own computer when you run `npm start`). Each job lives in the system temp folder and is deleted after you save the file, or after 30 minutes. The server logs only start-up and error categories, listens on `127.0.0.1` unless `HOST` is set, and refuses requests from other web sites. It has no accounts: if you open it to a network, anyone on that network can use it.

## Tested and not tested

**Tested** (headless desktop Chrome 141, FFmpeg 6.1, Linux):

- Scene plan, container reader and an end-to-end render through the real server: 24 automated tests.
- Mixed photos and clips in the real UI at 390x844, 320x568 and 1280x800: choosing files, the loading progress, the clip cap (10) and item cap (30), preview, trim, Arrange, Edit, mute, no horizontal scroll, 44 px touch targets.
- Playback of real clips: footage drawn into the movie, kept within about 0.05 s of the clock, portrait clip with rotation metadata shown upright and unstretched, a clip with no audio track leaving the music alone, music ducking and mute, and a clip used to its last frame not restarting.
- Failure messages for H.264/HEVC MOV (this Chrome has no H.264 or HEVC decoder), a corrupt `.mov`, a clip under 1.5 s, a text file and a damaged photo.
- MP4 export through the real UI, with a title, then inspected: size, codecs, duration equal to the plan, pictures at several times, sound level over time (music dips under clips and returns), HEVC MOV with rotation, H.264 MOV, silent clip, HLG clip, custom trim.

**Not tested:**

- **Safari on a real iPhone**: HEVC/MOV playback, clip sound starting after a tap, ring switch behaviour, volume fades, frame capture before first play, canvas speed, MP4 saving.
- Firefox, Android, Safari on Mac.
- H.264/HEVC clips *in the browser preview*: the sandbox's Chrome cannot decode them, so the preview pipeline was tested with VP9 versions of the same clips; the renderer was tested with the real H.264 and HEVC files.
- A real iPhone HDR clip (the HLG test file is synthetic) and long, large (hundreds of MB) clips.
- The music tracks have not been listened to, only level-checked.
- The published claude.ai Artifact: whether its content-security policy lets the page play video from a file you pick is unknown. The reliable test is `npm start`.

## Credits

See `public/CREDITS.md`. Sample photos are public domain or Creative Commons Attribution 2.0. The music is original and synthesized in `tools/make_music.py`. There is no sample video: test clips were generated with FFmpeg and are not included.

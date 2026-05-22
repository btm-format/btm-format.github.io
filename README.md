# btm-format.github.io

Live demo and landing page for the **BTM (Beat-Tracking Media)** format family.

The page at <https://btm-format.github.io/> demonstrates the BTMA (Beat-Tracking
Media — Animation) profile: GIFs that retempo themselves in real time to match
accompanying music. Three sample BTMAs are bundled, three DJ-style audio tracks
with pitch-preserved tempo controls drive the renderers, and you can upload your
own GIF to see it converted to a BTMA on the fly.

For the format specification itself, see <https://github.com/btm-format/spec>.

## Files

- `index.html`, `style.css` — page chrome.
- `btma.js` — BTMA v0.2 encoder, parser, and renderer. Depends only on
  [`gifuct-js`](https://github.com/matt-way/gifuct-js) (loaded from esm.sh) for
  GIF frame decoding.
- `app.js` — page glue: audio players with `preservesPitch` time-stretching,
  sample loader, upload flow, BTMA renderer wiring.
- `assets/` — bundled MP3s and sample GIFs.

## Running locally

ES modules and `fetch()` need a real HTTP origin — opening `index.html`
directly from disk will not work. From this directory:

```sh
python -m http.server 8000
```

Then open <http://localhost:8000/>.

## How sync works in this demo

The demo uses **known BPMs** for the bundled tracks rather than audio-based BPM
detection. Each track's slider sets a target BPM; the browser's native
`HTMLMediaElement.preservesPitch` time-stretches the audio so pitch stays
constant as tempo changes (the same effect DJ software produces). The active
track's effective BPM drives a shared `BeatClock`, which the BTMA renderers
follow.

When no track is playing, the renderers fall back to the GIF's native
per-frame delays — BTMA spec §5.2 non-aware playback. The BTMA file is a
strict superset of GIF89a, so this is always a valid playback path.

For a production deployment (e.g. a Twitch viewer extension), live BPM would
come from one of:

- A sidechannel from the DJ's software (Ableton Link, OBS plugin, custom
  WebSocket bridge — sample-accurate).
- Real-time audio analysis on the viewer's side (best-effort; reliable for
  some genres, error-prone for others — see `beat-detect.js` in the project's
  development history for one implementation).
- Manual override (DJ types `!bpm 174` in chat, viewer extension picks it up).

## License

Code is released under the [Apache License 2.0](LICENSE).

The BTM specification it implements is released separately under
[CC-BY-4.0](https://github.com/btm-format/spec/blob/main/LICENSE).

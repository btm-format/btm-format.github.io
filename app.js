// BTMA demo page glue.
// Apache-2.0.
//
// Each demo track has a known authored BPM and a speed slider. The browser's
// native `preservesPitch` keeps the key constant as playbackRate changes, so
// the audio sounds natural at any speed (like DJ software). Effective BPM is
// just `track.bpm × audio.playbackRate`, which drives the BTMA renderer's
// shared beat clock directly — no audio-based detection involved.

import {
  gifToBtma,
  prepareImageForRender,
  detectImageFormat,
  BtmaRenderer,
  BeatClock,
} from './btma.js';

// Authored BPMs for the bundled tracks. The speed slider scales these.
const TRACKS = [
  { name: 'DnB',         src: 'assets/DnB.mp3',         bpm: 174 },
  { name: 'Tech House',  src: 'assets/Tech House.mp3',  bpm: 128 },
  { name: 'Techno',      src: 'assets/Techno.mp3',      bpm: 140 },
];

const RENDER_SIZES = [28, 56, 112];
const SAMPLE_RENDER_SIZES = [112];
const MAX_UPLOAD_BYTES = 1024 * 1024; // 1 MB

const SAMPLE_IMAGES = [
  { src: 'assets/sg_128.gif',            label: 'sg_128.gif',            beats: 1 },
  { src: 'assets/heed.gif',              label: 'heed.gif',              beats: 1 },
  { src: 'assets/rm_100.gif',            label: 'rm_100.gif',            beats: 2 },
  { src: 'assets/meowingtons.btma',      label: 'meowingtons.btma' },
  { src: 'assets/triplet_sample.webp',   label: 'triplet_sample.webp',   spec: { count: 3, bpb: 0.333 } },
  { src: 'assets/septuplet_sample.webp', label: 'septuplet_sample.webp', spec: { count: 8, bpb: -0.875 } },
];

// Speed slider range in BPM units around each track's nominal tempo.
const BPM_SLIDER_RANGE = 20;   // ± this many BPM from the track's nominal
const BPM_SLIDER_STEP = 1;

const sharedClock = new BeatClock(null);  // start with no BPM — renderers
                                          // fall back to GIF native timing
const audioEls = [];           // each is annotated with .trackBpm and .targetBpm

function buildPlayers() {
  const ul = document.getElementById('players');
  for (const t of TRACKS) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'track-name';
    name.textContent = t.name;

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = t.src;
    audio.crossOrigin = 'anonymous';
    // Preserve pitch when playbackRate changes (DJ-software-style time-stretch).
    audio.preservesPitch = true;
    audio.trackBpm = t.bpm;
    audio.targetBpm = t.bpm;
    audio.playbackRate = 1.0;

    // Per-track speed control. Labeled in target BPM so the DJ context is clear.
    const speedBox = document.createElement('span');
    speedBox.className = 'speed-control';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(t.bpm - BPM_SLIDER_RANGE);
    slider.max = String(t.bpm + BPM_SLIDER_RANGE);
    slider.step = String(BPM_SLIDER_STEP);
    slider.value = String(t.bpm);
    const speedLabel = document.createElement('span');
    speedLabel.className = 'speed-label';
    speedLabel.textContent = `${t.bpm} bpm`;
    speedBox.append(slider, speedLabel);

    slider.addEventListener('input', () => {
      const targetBpm = Number(slider.value);
      audio.targetBpm = targetBpm;
      audio.playbackRate = targetBpm / t.bpm;
      speedLabel.textContent = `${targetBpm} bpm`;
      if (!audio.paused) setActiveBpm(targetBpm);
    });

    li.append(name, audio, speedBox);
    ul.append(li);
    audioEls.push(audio);

    audio.addEventListener('play', () => {
      for (const other of audioEls) {
        if (other !== audio && !other.paused) other.pause();
      }
      setActiveBpm(audio.targetBpm);
    });
    audio.addEventListener('pause', onPlaybackChange);
    audio.addEventListener('ended', onPlaybackChange);
  }
}

function onPlaybackChange() {
  const playing = audioEls.find(a => !a.paused);
  if (playing) {
    setActiveBpm(playing.targetBpm);
  } else {
    // Nothing is playing — withdraw the BPM signal so the BTMA renderers
    // fall back to GIF native timing (spec §5.2).
    setActiveBpm(null);
  }
}

function setActiveBpm(bpm) {
  const el = document.getElementById('bpm-value');
  el.textContent = bpm == null ? '0' : String(bpm);
  sharedClock.setBpm(bpm);
}

function formatBtmaStatus(metadata) {
  const delays = metadata.frameDelays || [];
  const allSame = delays.length > 0 && delays.every(d => d === delays[0]);
  const delayStr = allSame ? `${delays[0]} ms` : 'varied';
  const totalMs = metadata.totalLoopMs;
  const totalStr = totalMs >= 1000
    ? `${(totalMs / 1000).toFixed(3)} s`
    : `${totalMs} ms`;
  const n = metadata.beatmarkers.length;
  const fmt = (metadata.format || '').toUpperCase();
  const lead = metadata.fromEmbedded
    ? 'Loaded (embedded)'
    : `${metadata.autoDetected ? 'Auto-converted' : 'Converted'} from ${fmt}`;
  return (
    `${lead}:\n` +
    `${metadata.frameCount} frames\n` +
    `Frame delay: ${delayStr}\n` +
    `Total loop time: ${totalStr}\n` +
    `default ${metadata.defaultBpm} BPM\n` +
    `${n} beatmarker${n === 1 ? '' : 's'}\n` +
    `${(metadata.bpb / 1000).toFixed(3)} beats per beatmarker`
  );
}

function makeRenderRow(containerEl, sizes = RENDER_SIZES) {
  containerEl.innerHTML = '';
  const canvases = [];
  for (const size of sizes) {
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    const cap = document.createElement('figcaption');
    cap.textContent = `${size}×${size}`;
    fig.append(c, cap);
    containerEl.append(fig);
    canvases.push({ canvas: c, size });
  }
  return canvases;
}

async function loadSamples() {
  const container = document.getElementById('samples-container');
  container.innerHTML = '';
  for (const sample of SAMPLE_IMAGES) {
    const block = document.createElement('div');
    block.className = 'sample-block';
    const row = document.createElement('div');
    row.className = 'render-row';
    const status = document.createElement('p');
    status.className = 'status';
    block.append(row, status);
    container.append(block);

    try {
      const resp = await fetch(sample.src);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const beatSpec = sample.spec || sample.beats;
      const prepared = await prepareImageForRender(bytes, beatSpec);
      console.log(`Sample ${sample.label}:`, prepared.info);
      const renderer = new BtmaRenderer();
      renderer.loadDecoded(prepared, sharedClock);
      for (const { canvas, size } of makeRenderRow(row, SAMPLE_RENDER_SIZES)) {
        renderer.addTarget(canvas, size);
      }
      status.className = 'status ok';
      status.textContent = formatBtmaStatus(prepared.info);
    } catch (e) {
      console.error(`Failed to load sample ${sample.label}:`, e);
      status.className = 'status error';
      status.textContent = `Failed to load: ${e.message}`;
    }
  }
  if (!audioEls.some(a => !a.paused)) setActiveBpm(null);
}

let uploadRenderer = null;

async function handleUpload(file, beatLength) {
  const statusEl = document.getElementById('upload-status');
  statusEl.className = 'status';
  statusEl.textContent = '';

  if (!file) return;
  if (!/\.(gif|webp|avif|btma|btmw|btmi)$/i.test(file.name) && !/^image\/(gif|webp|avif)$/.test(file.type)) {
    statusEl.className = 'status error';
    statusEl.textContent = 'Please upload a .gif, .webp, .avif, .btma, .btmw, or .btmi file.';
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    statusEl.className = 'status error';
    statusEl.textContent = `File is ${Math.round(file.size / 1024)} KB — exceeds the 1024 KB (1 MB) limit.`;
    return;
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const prepared = await prepareImageForRender(bytes, beatLength);
    statusEl.className = 'status ok';
    statusEl.textContent = formatBtmaStatus(prepared.info);
    const uploadLabel = document.getElementById('upload-label');
    const beatLengthLabel = document.getElementById('beat-length-label');
    if (prepared.info.fromEmbedded) {
      uploadLabel.textContent = 'Native BTMA uploaded.';
      beatLengthLabel.hidden = true;
    } else {
      uploadLabel.textContent =
        `Your uploaded ${prepared.info.format.toUpperCase()}, converted to a BTMA.`;
      beatLengthLabel.hidden = false;
    }

    if (uploadRenderer) uploadRenderer.dispose();
    uploadRenderer = new BtmaRenderer();
    uploadRenderer.loadDecoded(prepared, sharedClock);
    const row = document.getElementById('upload-render');
    for (const { canvas, size } of makeRenderRow(row)) {
      uploadRenderer.addTarget(canvas, size);
    }
  } catch (e) {
    console.error(e);
    statusEl.className = 'status error';
    statusEl.textContent = `Conversion failed: ${e.message}`;
  }
}

function bindUploadControls() {
  const input = document.getElementById('gif-input');
  const sel = document.getElementById('beat-length');
  const trigger = () => {
    const f = input.files && input.files[0];
    const v = sel.value === 'auto' ? 'auto' : parseFloat(sel.value);
    if (f) handleUpload(f, v);
  };
  input.addEventListener('change', trigger);
  sel.addEventListener('change', trigger);
}

async function main() {
  buildPlayers();
  bindUploadControls();
  await loadSamples();
}

main();

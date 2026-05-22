// BTMA v0.2 encoder, parser, and renderer.
// Apache-2.0.
//
// Spec: BTM1Sync-schema-v0.2.md, BTMA-spec-v0.2.md.

import { parseGIF, decompressFrames } from 'https://esm.sh/gifuct-js@2.1.2';

const BTM1SYNC_ID = [0x42, 0x54, 0x4D, 0x31, 0x53, 0x79, 0x6E, 0x63]; // "BTM1Sync"
const AUTH_CODE = [0x31, 0x2E, 0x30]; // "1.0"
const SCHEMA_VERSION = 0x0002;

// ---------- Surgical BTMA insert into an existing GIF ----------

// Locate the byte offset immediately after the Logical Screen Descriptor
// (and the Global Color Table, if present). That is where Application
// Extension blocks must be inserted (BTMA spec §4.3).
function findInsertOffset(gif) {
  if (gif.length < 13) throw new Error('Not a GIF: too short');
  const header = String.fromCharCode(gif[0], gif[1], gif[2], gif[3], gif[4], gif[5]);
  if (header !== 'GIF89a' && header !== 'GIF87a') throw new Error('Not a GIF: bad header');
  const packed = gif[10];
  const gctFlag = (packed & 0x80) !== 0;
  const gctSizeExp = packed & 0x07;
  const gctBytes = gctFlag ? 3 * (1 << (gctSizeExp + 1)) : 0;
  return 13 + gctBytes;
}

// Build the BTM1Sync v0.2 payload bytes (Section 4 of schema).
// beatmarkers is an array of real numbers (fractional frame positions).
function buildBTM1SyncPayload(defaultBpm, bpb, beatmarkers) {
  if (!Number.isInteger(defaultBpm) || defaultBpm < 1 || defaultBpm > 0xFFFF) {
    throw new Error(`default_bpm out of range: ${defaultBpm}`);
  }
  if (!Number.isInteger(bpb) || bpb === 0 || bpb < -1000 || bpb > 1000) {
    throw new Error(`beats_per_beatmarker out of range: ${bpb}`);
  }
  const count = beatmarkers.length;
  if (count < 1 || count > 0xFFFF) throw new Error(`beatmarker_count out of range: ${count}`);

  const buf = new Uint8Array(16 + 4 * count);
  const dv = new DataView(buf.buffer);

  for (let i = 0; i < 8; i++) buf[i] = BTM1SYNC_ID[i];
  dv.setUint16(8, SCHEMA_VERSION, false);
  dv.setUint16(10, defaultBpm, false);
  dv.setInt16(12, bpb, false);
  dv.setUint16(14, count, false);
  for (let i = 0; i < count; i++) {
    const fixed = Math.max(0, Math.round(beatmarkers[i] * 65536));
    dv.setUint32(16 + 4 * i, fixed >>> 0, false);
  }
  return buf;
}

// Wrap a BTM1Sync payload in the GIF Application Extension block envelope.
function buildAppExtBlock(payload) {
  if (payload.length > 255) {
    throw new Error('Multi-sub-block packing not yet implemented (need beatmarker_count <= 59)');
  }
  const out = new Uint8Array(3 + 11 + 1 + payload.length + 1);
  let p = 0;
  out[p++] = 0x21;        // Extension Introducer
  out[p++] = 0xFF;        // Application Extension Label
  out[p++] = 0x0B;        // Block size = 11
  for (const b of BTM1SYNC_ID) out[p++] = b;
  for (const b of AUTH_CODE) out[p++] = b;
  out[p++] = payload.length;
  out.set(payload, p);
  p += payload.length;
  out[p++] = 0x00;        // Block terminator (zero-length sub-block)
  return out;
}

// Compute (count, bpb) from a user-supplied loop length L in beats.
// L in (0, 1]: count = 1, bpb = round(L * 1000)
// L >= 1 integer: count = L, bpb = +1000
// Returns { count, bpb } where bpb is int in 1/1000-beat units.
export function loopLengthToParams(L) {
  if (!(L > 0)) throw new Error(`Loop length must be positive: ${L}`);
  if (L < 1) return { count: 1, bpb: Math.round(L * 1000) };
  if (Number.isInteger(L)) return { count: L, bpb: 1000 };
  // Non-integer L > 1: shortest count with |bpb| <= 1.
  const count = Math.ceil(L);
  return { count, bpb: Math.round((L / count) * 1000) };
}

// Convert an existing GIF byte stream into a BTMA byte stream, per BTMA §7.1.
// loopLengthBeats: user-declared loop length in beats (e.g. 0.5, 1, 2).
// Returns Uint8Array of BTMA bytes and the metadata used.
export async function gifToBtma(gifBytes, loopLengthBeats) {
  // Parse frames to count F and total duration.
  const parsed = parseGIF(gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength));
  const frames = decompressFrames(parsed, true);
  const F = frames.length;
  if (F < 1) throw new Error('GIF has no frames');
  // Sum delays. gifuct-js delivers `delay` in milliseconds.
  let totalMs = 0;
  for (const f of frames) totalMs += (f.delay && f.delay > 0) ? f.delay : 10; // 10ms fallback if missing
  const originalLoopSeconds = totalMs / 1000;

  const { count, bpb } = loopLengthToParams(loopLengthBeats);
  const bpbReal = Math.abs(bpb) / 1000;
  const defaultBpm = Math.max(1, Math.min(0xFFFF, Math.round(60 * count * bpbReal / originalLoopSeconds)));

  // Evenly-spaced beatmarkers at fractional positions i*F/count.
  const beatmarkers = [];
  for (let i = 0; i < count; i++) beatmarkers.push((i * F) / count);

  const payload = buildBTM1SyncPayload(defaultBpm, bpb, beatmarkers);
  const appExt = buildAppExtBlock(payload);
  const insertAt = findInsertOffset(gifBytes);

  const out = new Uint8Array(gifBytes.length + appExt.length);
  out.set(gifBytes.subarray(0, insertAt), 0);
  out.set(appExt, insertAt);
  out.set(gifBytes.subarray(insertAt), insertAt + appExt.length);

  return {
    bytes: out,
    metadata: { defaultBpm, bpb, beatmarkers, frameCount: F, sourceLoopSeconds: originalLoopSeconds },
  };
}

// ---------- BTMA parser ----------

// Walk the GIF byte stream, locate the BTM1Sync Application Extension block,
// and return its parsed metadata. Returns null if not found / invalid.
export function parseBtma(bytes) {
  let p = findInsertOffset(bytes);
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3B) return null;                        // GIF trailer
    if (b === 0x21) {                                   // extension block
      const label = bytes[p + 1];
      if (label === 0xFF && bytes[p + 2] === 0x0B) {
        // Application Extension. Check identifier + auth code.
        let match = true;
        for (let i = 0; i < 8; i++) if (bytes[p + 3 + i] !== BTM1SYNC_ID[i]) { match = false; break; }
        if (match) {
          for (let i = 0; i < 3; i++) if (bytes[p + 11 + i] !== AUTH_CODE[i]) { match = false; break; }
        }
        // Read sub-blocks regardless (to advance past this AppExt).
        let sp = p + 14;
        const collected = [];
        while (sp < bytes.length && bytes[sp] !== 0) {
          const len = bytes[sp];
          for (let i = 0; i < len; i++) collected.push(bytes[sp + 1 + i]);
          sp += 1 + len;
        }
        const afterExt = sp + 1; // past the zero-length terminator
        if (match) {
          const payload = new Uint8Array(collected);
          const meta = parseBtm1Sync(payload);
          if (meta) return meta;
        }
        p = afterExt;
        continue;
      }
      // Other extension: skip via sub-block walk.
      let sp = p + 2;
      if (label === 0xF9 || label === 0x01 || label === 0xFE || label === 0xFF) sp = p + 2;
      // Generic: extension introducer + label, then sub-blocks.
      while (sp < bytes.length && bytes[sp] !== 0) sp += 1 + bytes[sp];
      p = sp + 1;
      continue;
    }
    if (b === 0x2C) return null;  // Image Descriptor reached; no BTMA found
    p++;                          // unexpected byte; skip defensively
  }
  return null;
}

function parseBtm1Sync(payload) {
  if (payload.length < 16) return null;
  for (let i = 0; i < 8; i++) if (payload[i] !== BTM1SYNC_ID[i]) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = dv.getUint16(8, false);
  if (version !== SCHEMA_VERSION) return null;
  const defaultBpm = dv.getUint16(10, false);
  const bpb = dv.getInt16(12, false);
  const count = dv.getUint16(14, false);
  if (payload.length !== 16 + 4 * count) return null;
  if (defaultBpm < 1 || count < 1) return null;
  if (bpb === 0 || bpb < -1000 || bpb > 1000) return null;

  const beatmarkers = [];
  let prev = -Infinity;
  for (let i = 0; i < count; i++) {
    const raw = dv.getUint32(16 + 4 * i, false);
    const val = raw / 65536;
    if (val <= prev) return null;
    beatmarkers.push(val);
    prev = val;
  }
  return { defaultBpm, bpb, beatmarkers };
}

// ---------- BTMA renderer ----------

// Decode GIF frames into a canvas-ready frame buffer using gifuct-js,
// handling disposal modes. Returns an array of ImageBitmap-equivalent canvases.
async function decodeGifFrames(gifBytes) {
  const ab = gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength);
  const parsed = parseGIF(ab);
  const frames = decompressFrames(parsed, true);
  const W = parsed.lsd.width;
  const H = parsed.lsd.height;

  // Build composited frames on a working canvas.
  const work = document.createElement('canvas');
  work.width = W;
  work.height = H;
  const wctx = work.getContext('2d');

  const composited = [];
  const delays = [];     // per-frame delay in ms, for non-aware fallback
  let prevSnapshot = null; // for disposal=3 (restore-to-previous)

  for (const f of frames) {
    // Pre-disposal: handle previous frame's disposal method.
    // (Per spec we'd track disposal of *previous* frame; simpler: do it on this frame's prev.)
    const patchCanvas = document.createElement('canvas');
    patchCanvas.width = f.dims.width;
    patchCanvas.height = f.dims.height;
    const pctx = patchCanvas.getContext('2d');
    const imgData = pctx.createImageData(f.dims.width, f.dims.height);
    imgData.data.set(f.patch);
    pctx.putImageData(imgData, 0, 0);

    // Apply patch onto the working canvas at the frame's offset.
    wctx.drawImage(patchCanvas, f.dims.left, f.dims.top);

    // Snapshot the composited canvas for this frame.
    const snap = document.createElement('canvas');
    snap.width = W;
    snap.height = H;
    snap.getContext('2d').drawImage(work, 0, 0);
    composited.push(snap);
    // gifuct-js delivers delay in milliseconds. GIFs with zero delay (some
    // tooling emits this) play as fast as possible; clamp to 10 ms as a
    // sane default (matching most browser GIF decoders).
    delays.push((f.delay && f.delay > 0) ? f.delay : 10);

    // Apply disposal for next iteration.
    const disposal = f.disposalType;
    if (disposal === 2) {
      // Restore to background: clear the patch region.
      wctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
    } else if (disposal === 3 && prevSnapshot) {
      wctx.clearRect(0, 0, W, H);
      wctx.drawImage(prevSnapshot, 0, 0);
    }
    prevSnapshot = snap;
  }

  return { frames: composited, width: W, height: H, delays };
}

// A BeatClock provides musical time (in beats) given a real time. External
// controllers can set the current BPM at any moment; the clock updates
// continuously without phase jumps. Setting BPM to null signals "no external
// BPM source available" — BtmaRenderer interprets this as the cue to fall
// back to the GIF's native frame delays (per BTMA spec §5.2).
export class BeatClock {
  constructor(initialBpm = 120) {
    this.bpm = initialBpm;
    this.refRealMs = performance.now();
    this.refBeats = 0;
  }
  setBpm(newBpm) {
    const now = performance.now();
    // Freeze the current beat reading before changing BPM (or going null) so
    // we don't lose place when external sync returns.
    if (this.bpm != null) {
      this.refBeats = this.beatsAt(now);
      this.refRealMs = now;
    }
    if (newBpm == null) {
      this.bpm = null;
      return;
    }
    if (!(newBpm > 0)) return;
    this.refRealMs = now;
    this.bpm = newBpm;
  }
  beatsAt(realMs) {
    if (this.bpm == null) return this.refBeats;
    return this.refBeats + (realMs - this.refRealMs) * (this.bpm / 60000);
  }
}

// BTMA renderer: given parsed BTMA bytes, decode frames and render the
// currently-correct frame to one or more target canvases at each animation tick.
// BPM is supplied via a BeatClock (which may be driven externally).
export class BtmaRenderer {
  constructor() {
    this.frames = null;          // composited frame canvases
    this.delays = null;          // per-frame delays in ms (native-fallback)
    this.totalLoopMs = 0;
    this.W = 0;
    this.H = 0;
    this.meta = null;            // { defaultBpm, bpb, beatmarkers }
    this.targets = [];           // [{ canvas, ctx, size }]
    this.clock = null;
    this.startBeat = 0;          // anchor beat (BTMA-aware mode)
    this.nativeStartMs = null;   // anchor real time (native-fallback mode)
    this.rafHandle = null;
  }

  async loadBytes(btmaBytes, clock) {
    const meta = parseBtma(btmaBytes);
    if (!meta) throw new Error('Bytes are not a valid BTMA file');
    const decoded = await decodeGifFrames(btmaBytes);
    this.frames = decoded.frames;
    this.delays = Array.isArray(decoded.delays) ? decoded.delays : [];
    // Guarantee a positive loop length. If the GIF has zero or missing delays
    // we synthesise 100 ms per frame so the renderer still advances.
    let total = this.delays.reduce((a, b) => a + b, 0);
    if (!(total > 0) && this.frames.length > 0) {
      this.delays = this.frames.map(() => 100);
      total = this.delays.reduce((a, b) => a + b, 0);
    }
    this.totalLoopMs = total;
    this.W = decoded.width;
    this.H = decoded.height;
    this.meta = meta;
    this.clock = clock || new BeatClock(meta.defaultBpm);
    this.startBeat = this.clock.beatsAt(performance.now());
    if (!this.rafHandle) this._tick();
  }

  // Add a target canvas at a given square size (28/56/112). The canvas will be
  // sized and the renderer will draw the current frame letterboxed if needed.
  addTarget(canvas, size) {
    canvas.width = size;
    canvas.height = size;
    this.targets.push({ canvas, ctx: canvas.getContext('2d'), size });
  }

  // Compute the fractional frame position pos(t) per schema §5.4.
  posAt(beats) {
    const m = this.meta;
    const N = m.beatmarkers.length;
    const F = this.frames.length;
    const bpbReal = m.bpb / 1000;            // signed
    const absBpb = Math.abs(bpbReal);
    const loopBeats = N * absBpb;
    // Beats elapsed since playback anchor.
    const elapsed = beats - this.startBeat;
    // Map elapsed beats into [0, loopBeats) using a positive modulo.
    let phase = elapsed % loopBeats;
    if (phase < 0) phase += loopBeats;
    // Which span are we in, and how far through it.
    const spanIndex = Math.floor(phase / absBpb);   // 0..N-1
    const spanFrac = (phase - spanIndex * absBpb) / absBpb; // 0..1

    if (bpbReal > 0) {
      // Forward: visit order is beatmarkers[0], [1], ..., [N-1]
      const a = m.beatmarkers[spanIndex];
      const b = m.beatmarkers[(spanIndex + 1) % N];
      // Span length: from a to b wrapping forward through F.
      const span = (b - a + F) % F || F;  // full wrap if b == a (single beatmarker)
      let pos = a + span * spanFrac;
      // Wrap into [0, F)
      pos = ((pos % F) + F) % F;
      return pos;
    } else {
      // Reverse: visit order is beatmarkers[0], [N-1], [N-2], ...
      // spanIndex k goes from beatmarkers[(-k) mod N] to beatmarkers[(-k-1) mod N], decreasing through frames.
      const a = m.beatmarkers[((-spanIndex) % N + N) % N];
      const b = m.beatmarkers[((-spanIndex - 1) % N + N) % N];
      // Reverse span length: from a back to b wrapping backward through F.
      const span = (a - b + F) % F || F;
      let pos = a - span * spanFrac;
      pos = ((pos % F) + F) % F;
      return pos;
    }
  }

  _tick() {
    try {
      if (this.frames && this.meta && this.targets.length && this.delays && this.delays.length) {
        let frameIdx;
        const now = performance.now();
        if (this.clock.bpm == null) {
          // No external BPM source — fall back to GIF native frame delays
          // (BTMA spec §5.2 non-aware playback semantics).
          if (this.nativeStartMs == null) this.nativeStartMs = now;
          const total = this.totalLoopMs > 0 ? this.totalLoopMs : 1000;
          const raw = (now - this.nativeStartMs) % total;
          const elapsed = raw < 0 ? raw + total : raw;
          let acc = 0;
          frameIdx = this.delays.length - 1;
          for (let i = 0; i < this.delays.length; i++) {
            acc += this.delays[i];
            if (elapsed < acc) { frameIdx = i; break; }
          }
        } else {
          // BTMA-aware: clock has a live BPM, follow it.
          if (this.nativeStartMs != null) {
            // We just came back from native mode — re-anchor BTMA timing so
            // beatmarkers[0] lines up with the next beat.
            this.startBeat = this.clock.beatsAt(now);
            this.nativeStartMs = null;
          }
          const beats = this.clock.beatsAt(now);
          const pos = this.posAt(beats);
          frameIdx = Math.floor(pos) % this.frames.length;
          if (frameIdx < 0) frameIdx += this.frames.length;
        }
        const src = this.frames[frameIdx];
        if (src) {
          for (const t of this.targets) {
            this._drawLetterboxed(t.ctx, src, t.size);
          }
        }
      }
    } catch (err) {
      console.error('[btma] _tick error:', err);
    }
    this.rafHandle = requestAnimationFrame(() => this._tick());
  }

  _drawLetterboxed(ctx, src, size) {
    // Clear to black.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    // Scale to fit, preserving aspect ratio.
    const sw = src.width, sh = src.height;
    const scale = Math.min(size / sw, size / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    const dx = Math.floor((size - dw) / 2);
    const dy = Math.floor((size - dh) / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, dx, dy, dw, dh);
  }

  dispose() {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    this.frames = null;
    this.meta = null;
    this.targets = [];
  }
}

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

// Infer the most plausible beat-count for a GIF given its total loop duration
// in seconds. Tries the common loop-length candidates and picks whichever
// produces a BPM closest to a dance-music sweet spot (~125 BPM by default),
// preferring values that fall inside [80, 200] BPM.
//
// When a known reference BPM is available (e.g. from the active stream's
// broadcast tempo), pass it as `referenceBpm` and detection becomes nearly
// unambiguous.
export function autoDetectLoopBeats(loopSeconds, { referenceBpm = null, target = 125 } = {}) {
  if (!(loopSeconds > 0)) return 1;
  const candidates = [0.5, 1, 2, 4, 8];
  const targetBpm = referenceBpm || target;
  let bestN = 1;
  let bestScore = Infinity;
  for (const n of candidates) {
    const bpm = (60 * n) / loopSeconds;
    const inRange = bpm >= 80 && bpm <= 200;
    // Smaller is better. Out-of-range candidates take a large penalty so
    // they only win when nothing fits.
    const score = (inRange ? 0 : 1000) + Math.abs(bpm - targetBpm);
    if (score < bestScore) { bestScore = score; bestN = n; }
  }
  return bestN;
}

// Convert an existing GIF byte stream into a BTMA byte stream, per BTMA §7.1.
// loopLengthBeats: user-declared loop length in beats (e.g. 0.5, 1, 2), OR
// the string 'auto' to infer it from the GIF's frame timing.
// Returns Uint8Array of BTMA bytes and the metadata used.
export async function gifToBtma(gifBytes, loopLengthBeats) {
  // Parse frames to count F and total duration.
  const parsed = parseGIF(gifBytes.buffer.slice(gifBytes.byteOffset, gifBytes.byteOffset + gifBytes.byteLength));
  const frames = decompressFrames(parsed, true);
  const F = frames.length;
  if (F < 1) throw new Error('GIF has no frames');
  // Sum delays. gifuct-js delivers `delay` in milliseconds.
  const frameDelays = frames.map(f => (f.delay && f.delay > 0) ? f.delay : 10);
  const totalMs = frameDelays.reduce((a, b) => a + b, 0);
  const originalLoopSeconds = totalMs / 1000;

  // If 'auto', infer the beat count from the loop duration.
  const wasAuto = (loopLengthBeats === 'auto');
  if (wasAuto) {
    loopLengthBeats = autoDetectLoopBeats(originalLoopSeconds);
  }

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
    metadata: {
      defaultBpm, bpb, beatmarkers,
      frameCount: F,
      frameDelays,                 // per-frame delays in ms
      totalLoopMs: totalMs,
      sourceLoopSeconds: originalLoopSeconds,
      autoDetected: wasAuto,
      detectedBeats: loopLengthBeats,
    },
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

// Walk the WebP RIFF byte stream, locate the BTMS chunk, and parse its
// payload as a BTM1Sync block. Returns null if not found / invalid.
export function parseBtmw(bytes) {
  if (!bytes || bytes.length < 12) return null;
  // Verify WebP signature.
  if (!(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)) {
    return null;
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 12;
  while (p + 8 <= bytes.length) {
    const fc = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const size = dv.getUint32(p + 4, true);    // little-endian per RIFF
    const payloadStart = p + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > bytes.length) return null;
    if (fc === 'BTMS') {
      const payload = bytes.subarray(payloadStart, payloadEnd);
      return parseBtm1Sync(payload);
    }
    p = payloadEnd + (size & 1);               // skip pad byte if odd
  }
  return null;
}

// Try to extract embedded BTM1Sync metadata from a file in any supported
// container format. Returns the parsed metadata object on success, null
// when no embedded BTM1Sync block is found or the format isn't supported.
export function tryParseEmbeddedBtm1Sync(bytes) {
  const fmt = detectImageFormat(bytes);
  if (fmt === 'gif') return parseBtma(bytes);
  if (fmt === 'webp') return parseBtmw(bytes);
  return null;
}

// ---------- Format detection and decoding ----------

// Detect a still/animated image format from magic bytes.
export function detectImageFormat(bytes) {
  if (!bytes || bytes.length < 12) return 'unknown';
  // GIF: "GIF87a" or "GIF89a"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  // WebP: "RIFF????WEBP"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  // AVIF: "....ftypavif" or "....ftypavis" at offset 4
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return 'unknown';
}

// Decode any animated image (GIF / WebP / AVIF). Returns the common shape
// { frames: HTMLCanvasElement[], width, height, delays: number[] (ms) }.
export async function decodeAnimatedImage(bytes) {
  const fmt = detectImageFormat(bytes);
  if (fmt === 'gif') return decodeGifFrames(bytes);
  if (fmt === 'webp') return decodeWithImageDecoder(bytes, 'image/webp');
  if (fmt === 'avif') return decodeWithImageDecoder(bytes, 'image/avif');
  throw new Error(`Unsupported image format (magic bytes don't match GIF/WebP/AVIF)`);
}

// Decode WebP / AVIF / etc. using the browser's native ImageDecoder API.
// Returns the same shape as decodeGifFrames.
async function decodeWithImageDecoder(bytes, mimeType) {
  if (typeof ImageDecoder === 'undefined') {
    throw new Error('ImageDecoder API not available in this browser; cannot decode ' + mimeType);
  }
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoder = new ImageDecoder({ data, type: mimeType });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const F = track.frameCount;
  const composited = [];
  const delays = [];
  let W = 0, H = 0;
  for (let i = 0; i < F; i++) {
    const result = await decoder.decode({ frameIndex: i });
    const image = result.image;
    W = image.displayWidth;
    H = image.displayHeight;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(image, 0, 0);
    composited.push(canvas);
    // VideoFrame.duration is in microseconds; convert to ms. May be null.
    delays.push(image.duration ? image.duration / 1000 : 100);
    image.close();
  }
  decoder.close();
  return { frames: composited, width: W, height: H, delays };
}

// Build BTMA renderer metadata + decoded frames from any animated image,
// without the GIF-byte round-trip. beatSpec may be:
//   - a number L (loop length in beats)
//   - the string 'auto'
//   - an object { count, bpb }  where bpb is real (e.g. 0.333), giving
//     direct control over the schema's beats_per_beatmarker / beatmarker_count
export async function prepareImageForRender(bytes, beatSpec) {
  const decoded = await decodeAnimatedImage(bytes);
  const F = decoded.frames.length;
  if (F < 1) throw new Error('Image has no animation frames');
  const totalMs = decoded.delays.reduce((a, b) => a + b, 0);
  const originalLoopSeconds = totalMs / 1000;

  // If the file already carries authored BTM1Sync metadata, that takes
  // precedence over whatever the caller's beatSpec would have inferred.
  const embedded = tryParseEmbeddedBtm1Sync(bytes);

  let count, bpb, wasAuto = false, defaultBpm, beatmarkers;

  if (embedded) {
    count = embedded.beatmarkers.length;
    bpb = embedded.bpb;
    defaultBpm = embedded.defaultBpm;
    beatmarkers = embedded.beatmarkers.slice();
  } else {
    if (beatSpec && typeof beatSpec === 'object') {
      count = beatSpec.count | 0;
      bpb = Math.round(beatSpec.bpb * 1000);
      if (!count || count < 1) throw new Error(`Bad beat spec: count=${count}`);
      if (bpb === 0 || bpb < -1000 || bpb > 1000) {
        throw new Error(`Bad beat spec: bpb=${beatSpec.bpb} → ${bpb} (must be in [-1000,1000] excl 0)`);
      }
    } else {
      let L = beatSpec;
      if (L === 'auto') { L = autoDetectLoopBeats(originalLoopSeconds); wasAuto = true; }
      const params = loopLengthToParams(L);
      count = params.count;
      bpb = params.bpb;
    }
    const bpbReal = Math.abs(bpb) / 1000;
    defaultBpm = Math.max(1, Math.min(0xFFFF,
      Math.round(60 * count * bpbReal / originalLoopSeconds)
    ));
    beatmarkers = [];
    for (let i = 0; i < count; i++) beatmarkers.push((i * F) / count);
  }

  return {
    frames: decoded.frames,
    delays: decoded.delays,
    width: decoded.width,
    height: decoded.height,
    meta: { defaultBpm, bpb, beatmarkers },
    info: {
      defaultBpm, bpb, beatmarkers,
      frameCount: F,
      frameDelays: decoded.delays,
      totalLoopMs: totalMs,
      sourceLoopSeconds: originalLoopSeconds,
      autoDetected: wasAuto,
      fromEmbedded: !!embedded,
      format: detectImageFormat(bytes),
    },
  };
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

// Scale a full-size frame canvas down to a target square size, letterboxed
// with black bars when the source isn't square. Uses iterative half-step
// bilinear downscaling — significantly sharper than a single drawImage
// call at large size reductions (which uses a small filter kernel).
function scaleFrameLetterboxed(src, targetSize) {
  const sw = src.width;
  const sh = src.height;
  const scale = Math.min(targetSize / sw, targetSize / sh);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  // Halve repeatedly until we're within 2× of the final scaled dims.
  let current = src;
  let cw = sw;
  let ch = sh;
  while (cw > dw * 2 && ch > dh * 2) {
    cw = Math.max(1, Math.floor(cw / 2));
    ch = Math.max(1, Math.floor(ch / 2));
    const tmp = document.createElement('canvas');
    tmp.width = cw;
    tmp.height = ch;
    const tctx = tmp.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(current, 0, 0, cw, ch);
    current = tmp;
  }

  const out = document.createElement('canvas');
  out.width = targetSize;
  out.height = targetSize;
  const octx = out.getContext('2d');
  octx.fillStyle = '#000';
  octx.fillRect(0, 0, targetSize, targetSize);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  const dx = Math.floor((targetSize - dw) / 2);
  const dy = Math.floor((targetSize - dh) / 2);
  octx.drawImage(current, dx, dy, dw, dh);
  return out;
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
    this.frames = null;          // full-size composited frame canvases
    this.framesBySize = null;    // Map<targetSize, scaledFrameCanvas[]> —
                                 // pre-rendered letterboxed versions
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

  // Load from already-decoded data (any image format). Bypasses the BTMA
  // byte round-trip used by loadBytes — useful for WebP/AVIF (which don't
  // have a defined container profile yet) and for samples that specify
  // explicit { count, bpb } metadata.
  loadDecoded({ frames, delays, meta }, clock) {
    this.frames = frames;
    this.framesBySize = new Map();
    this.delays = Array.isArray(delays) ? delays : [];
    let total = this.delays.reduce((a, b) => a + b, 0);
    if (!(total > 0) && this.frames.length > 0) {
      this.delays = this.frames.map(() => 100);
      total = this.delays.reduce((a, b) => a + b, 0);
    }
    this.totalLoopMs = total;
    this.W = this.frames[0] ? this.frames[0].width : 0;
    this.H = this.frames[0] ? this.frames[0].height : 0;
    this.meta = meta;
    this.clock = clock || new BeatClock(meta.defaultBpm);
    this.startBeat = this.clock.beatsAt(performance.now());
    if (!this.rafHandle) this._tick();
  }

  async loadBytes(btmaBytes, clock) {
    const meta = parseBtma(btmaBytes);
    if (!meta) throw new Error('Bytes are not a valid BTMA file');
    const decoded = await decodeGifFrames(btmaBytes);
    this.frames = decoded.frames;
    this.framesBySize = new Map();
    this.delays = Array.isArray(decoded.delays) ? decoded.delays : [];
    // Guarantee a positive loop length. If the GIF has zero or missing delays
    // we synthesise 100 ms per frame so the renderer still advances.
    let total = this.delays.reduce((a, b) => a + b, 0);
    if (!(total > 0) && this.frames.length > 0) {
      this.delays = this.frames.map(() => 100);
      total = this.delays.reduce((a, b) => a + b, 0);
    }
    this.totalLoopMs = total;
    console.log(
      `[btma] loaded ${this.frames.length} frames, ` +
      `delays=[${this.delays.slice(0, 8).join(',')}${this.delays.length > 8 ? '…' : ''}], ` +
      `totalLoopMs=${this.totalLoopMs}, ` +
      `meta=${JSON.stringify({ defaultBpm: meta.defaultBpm, bpb: meta.bpb, beatmarkers: meta.beatmarkers })}`
    );
    this.W = decoded.width;
    this.H = decoded.height;
    this.meta = meta;
    this.clock = clock || new BeatClock(meta.defaultBpm);
    this.startBeat = this.clock.beatsAt(performance.now());
    if (!this.rafHandle) this._tick();
  }

  // Add a target canvas at a given square size (28/56/112). The first time a
  // given size is requested we pre-render every frame at that size using
  // iterative half-step downscaling and letterboxing, then cache. Per-tick
  // drawing is then a 1:1 blit — fast and much higher visual quality than
  // single-step downsampling every frame.
  addTarget(canvas, size) {
    canvas.width = size;
    canvas.height = size;
    if (!this.framesBySize.has(size) && this.frames) {
      const scaled = this.frames.map((f) => scaleFrameLetterboxed(f, size));
      this.framesBySize.set(size, scaled);
    }
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
          // No external BPM source — fall back to native frame delays. Walk
          // them backward when bpb is negative so reverse-playback BTMAs
          // keep their authored direction even without a live BPM.
          if (this.nativeStartMs == null) this.nativeStartMs = now;
          const total = this.totalLoopMs > 0 ? this.totalLoopMs : 1000;
          const raw = (now - this.nativeStartMs) % total;
          const elapsed = raw < 0 ? raw + total : raw;
          const reverse = this.meta && this.meta.bpb < 0;
          let acc = 0;
          if (reverse) {
            frameIdx = 0;
            for (let i = this.delays.length - 1; i >= 0; i--) {
              acc += this.delays[i];
              if (elapsed < acc) { frameIdx = i; break; }
            }
          } else {
            frameIdx = this.delays.length - 1;
            for (let i = 0; i < this.delays.length; i++) {
              acc += this.delays[i];
              if (elapsed < acc) { frameIdx = i; break; }
            }
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
        if (this.frames[frameIdx]) {
          for (const t of this.targets) {
            const cached = this.framesBySize.get(t.size);
            const src = cached ? cached[frameIdx] : this.frames[frameIdx];
            if (cached) {
              // Pre-scaled, letterboxed; just blit 1:1.
              t.ctx.drawImage(src, 0, 0);
            } else {
              this._drawLetterboxed(t.ctx, src, t.size);
            }
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

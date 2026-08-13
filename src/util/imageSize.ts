// Pixel dimensions of an image, read from its header without decoding it.
//
// This exists because one of the vision model's limits is a hard one: over
// `MAX_DIMENSION_PX` on either side the request is rejected outright rather than
// downscaled (providers/imageLimits.ts). Publishing that number while accepting a
// file that breaks it puts the upload back in the state this whole change is about —
// accepted here, dead minutes later inside a model call, naming nothing. Pixels are
// also cheap in bytes (a 2400x2400 line-art scan is 39 KB), so the byte cap does not
// stand in for this one.
//
// Header-only on purpose: no decode, no dependency, no allocation proportional to the
// image. Every format in the allowlist puts its size in the first few dozen bytes.
// Anything unreadable returns null and is NOT rejected — a format this cannot parse
// must not become a format Iris refuses.

export interface ImageDimensions {
  width: number;
  height: number;
}

export function imageDimensions(buf: Buffer): ImageDimensions | null {
  const size = fromPng(buf) ?? fromGif(buf) ?? fromWebp(buf) ?? fromJpeg(buf);
  // A zero or negative side means the header was misread, not that the image is
  // empty. Treat it as unreadable rather than feeding a nonsense number to a check.
  if (!size || size.width < 1 || size.height < 1) return null;
  return size;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG: an 8-byte signature, then IHDR, whose first two fields are the dimensions as
// 32-bit big-endian. IHDR is required by the spec to be the first chunk.
function fromPng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// GIF: the logical screen descriptor follows the 6-byte magic, 16-bit little-endian.
function fromGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const magic = buf.toString("latin1", 0, 6);
  if (magic !== "GIF87a" && magic !== "GIF89a") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

// WebP: a RIFF container whose first chunk says which of the three encodings it is,
// each of which stores its size differently.
function fromWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 16) return null;
  if (buf.toString("latin1", 0, 4) !== "RIFF") return null;
  if (buf.toString("latin1", 8, 12) !== "WEBP") return null;

  const chunk = buf.toString("latin1", 12, 16);
  // Extended: a 24-bit little-endian canvas size, stored minus one.
  if (chunk === "VP8X") {
    if (buf.length < 30) return null;
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  // Lossless: a 1-byte signature, then 14 bits each packed into one little-endian
  // word, also stored minus one.
  if (chunk === "VP8L") {
    if (buf.length < 25) return null;
    if (buf[20] !== 0x2f) return null; // not a VP8L bitstream after all
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  // Lossy: a VP8 key frame, whose 3-byte start code precedes 14-bit dimensions —
  // the upper two bits of each word are a scaling hint, not size.
  if (chunk === "VP8 ") {
    if (buf.length < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// JPEG: walk the marker segments to the frame header. Unlike the others there is no
// fixed offset — EXIF, ICC profiles and comments all sit in front of it, and their
// sizes vary per encoder.
function fromJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  // +9 because the shortest thing worth reading here is a frame header: marker,
  // length, precision, then the two 16-bit sides.
  while (off + 9 <= buf.length) {
    if (buf[off] !== 0xff) return null; // out of step with the segments: do not guess
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off++; // fill byte before the real marker
      continue;
    }
    // Standalone markers, carrying no length: restart intervals and the delimiters.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    // SOF0-SOF15 carry the frame size. The three exceptions in that range are other
    // tables (Huffman, arithmetic coding) and the reserved JPG marker.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // Height first in a JPEG frame header, then width.
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    const length = buf.readUInt16BE(off + 2);
    if (length < 2) return null; // a segment that cannot advance would loop forever
    off += 2 + length;
  }
  return null;
}

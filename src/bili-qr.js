/**
 * A minimal QR Code encoder (Model 2, byte mode, ECC level M, versions 1-10).
 *
 * Why hand-written: this plugin is installed with `link:`, so Node resolves
 * dependencies from the plugin's real directory, and that directory has no
 * `node_modules`. Any npm QR library would be unresolvable at runtime — the
 * same reason this plugin imports nothing from `@deepseek-ai/*`. Node's own
 * `zlib` is enough for the PNG container, so the whole thing stays dependency
 * free.
 *
 * Scope is deliberately narrow: byte mode covers a URL, ECC level M survives a
 * clean screen, and version 10 holds 213 bytes — far beyond any login URL.
 * Verified module-for-module against the `qrcode` npm package in the dev test.
 */

/** Generator for GF(2^8) with primitive polynomial 0x11D. */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

/**
 * Multiply two GF(256) elements.
 * @param {number} a - first factor.
 * @param {number} b - second factor.
 * @returns {number} the product.
 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Build the Reed-Solomon generator polynomial of the given degree.
 * @param {number} degree - number of error-correction codewords.
 * @returns {number[]} coefficients, highest degree first.
 */
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/**
 * Compute Reed-Solomon error-correction codewords.
 * @param {Uint8Array} data - data codewords for one block.
 * @param {number} ecCount - how many EC codewords to produce.
 * @returns {Uint8Array} the EC codewords.
 */
function rsEncode(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const work = new Uint8Array(data.length + ecCount);
  work.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const coef = work[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j += 1) {
      work[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return work.slice(data.length);
}

/**
 * Block layout per version at ECC level M.
 * `ec` = EC codewords per block; group 1 / group 2 block counts and data sizes.
 */
const EC_M = {
  1: { ec: 10, g1: 1, d1: 16, g2: 0, d2: 0 },
  2: { ec: 16, g1: 1, d1: 28, g2: 0, d2: 0 },
  3: { ec: 26, g1: 1, d1: 44, g2: 0, d2: 0 },
  4: { ec: 18, g1: 2, d1: 32, g2: 0, d2: 0 },
  5: { ec: 24, g1: 2, d1: 43, g2: 0, d2: 0 },
  6: { ec: 16, g1: 4, d1: 27, g2: 0, d2: 0 },
  7: { ec: 18, g1: 4, d1: 31, g2: 0, d2: 0 },
  8: { ec: 22, g1: 2, d1: 38, g2: 2, d2: 39 },
  9: { ec: 22, g1: 3, d1: 36, g2: 2, d2: 37 },
  10: { ec: 26, g1: 4, d1: 43, g2: 1, d2: 44 },
};

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** ECC level indicator bits: L=01, M=00, Q=11, H=10. */
const EC_LEVEL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/**
 * Count data codewords available at a version and level.
 * @param {number} version - 1-10.
 * @returns {number} data codeword count.
 */
function dataCodewordCount(version) {
  const spec = EC_M[version];
  if (spec === undefined) throw new Error("unsupported QR version " + version);
  return spec.g1 * spec.d1 + spec.g2 * spec.d2;
}

/**
 * Byte-mode capacity for a version, in bytes.
 * @param {number} version - 1-10.
 * @returns {number} usable payload bytes.
 */
function byteCapacity(version) {
  const bits = dataCodewordCount(version) * 8;
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((bits - 4 - countBits) / 8);
}

/**
 * Pick the smallest version that fits the payload.
 * @param {number} byteLength - payload length in bytes.
 * @returns {number} a version in 1-10.
 */
function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    if (byteCapacity(version) >= byteLength) return version;
  }
  throw new Error(
    "payload of " + byteLength + " bytes exceeds the largest supported QR version (10, " + byteCapacity(10) + " bytes)"
  );
}

/**
 * Encode the payload into data codewords, with terminator and pad bytes.
 * @param {Uint8Array} bytes - payload.
 * @param {number} version - chosen version.
 * @returns {Uint8Array} data codewords.
 */
function encodeData(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCodewordCount(version) * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  for (let i = 0; i < terminator; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const pads = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length < capacityBits) {
    push(pads[padIndex % 2], 8);
    padIndex += 1;
  }

  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i += 1) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i * 8 + j];
    out[i] = value;
  }
  return out;
}

/**
 * Split into blocks, add EC codewords, then interleave.
 * @param {Uint8Array} data - data codewords.
 * @param {number} version - chosen version.
 * @returns {Uint8Array} the final codeword stream.
 */
function buildCodewords(data, version) {
  const spec = EC_M[version];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < spec.g1; i += 1) {
    blocks.push({ data: data.slice(offset, offset + spec.d1) });
    offset += spec.d1;
  }
  for (let i = 0; i < spec.g2; i += 1) {
    blocks.push({ data: data.slice(offset, offset + spec.d2) });
    offset += spec.d2;
  }
  for (const block of blocks) block.ec = rsEncode(block.data, spec.ec);

  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return Uint8Array.from(out);
}

/**
 * Encode the 15-bit format information with BCH(15,5) and the fixed mask.
 * @param {string} level - "L" | "M" | "Q" | "H".
 * @param {number} mask - mask pattern 0-7.
 * @returns {number} the 15-bit value.
 */
function formatBits(level, mask) {
  const data = (EC_LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/**
 * Encode the 18-bit version information with BCH(18,6).
 * @param {number} version - 7-10.
 * @returns {number} the 18-bit value.
 */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** The eight data-mask predicates. */
const MASKS = [
  (row, col) => (row + col) % 2 === 0,
  (row) => row % 2 === 0,
  (row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

/**
 * Build the module matrix for one version / mask combination.
 * @param {number} version - chosen version.
 * @param {number} mask - mask pattern 0-7.
 * @param {Uint8Array} codewords - interleaved codeword stream.
 * @returns {{size: number, modules: Uint8Array[]}} the matrix, 1 = dark.
 */
function buildMatrix(version, mask, codewords) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunction = (row, col, dark) => {
    if (row < 0 || row >= size || col < 0 || col >= size) return;
    modules[row][col] = dark ? 1 : 0;
    isFunction[row][col] = 1;
  };

  // Finder patterns plus their separators (drawn from -1 to 7 to include them).
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const ring =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setFunction(row + r, col + c, ring);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i <= size - 9; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three finder corners.
  const centres = ALIGNMENT[version];
  for (const row of centres) {
    for (const col of centres) {
      const onFinder =
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setFunction(row + r, col + c, dark);
        }
      }
    }
  }

  // Reserve the format-information areas.
  for (let i = 0; i <= 8; i += 1) {
    if (!isFunction[8][i]) setFunction(8, i, false);
    if (!isFunction[i][8]) setFunction(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(size - 1 - i, 8, false);
    setFunction(8, size - 1 - i, false);
  }
  // The dark module is always set.
  setFunction(size - 8, 8, true);

  // Reserve the version-information areas (version 7 and above).
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        setFunction(size - 11 + j, i, false);
        setFunction(i, size - 11 + j, false);
      }
    }
  }

  // Place data bits in the zigzag order.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < size; i += 1) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c += 1) {
        const cc = col - c;
        if (isFunction[row][cc]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex += 1;
        }
        modules[row][cc] = bit;
      }
    }
    upward = !upward;
  }

  // Apply the data mask to non-function modules.
  const maskFn = MASKS[mask];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (isFunction[row][col]) continue;
      if (maskFn(row, col)) modules[row][col] ^= 1;
    }
  }

  // Format information, in two copies.
  //
  // Bit 0 (the LSB) sits at (row 0, col 8) — column 8 running downward — and
  // the second copy runs along row 8 from the right edge leftward. Swapping row
  // and column here still produces a plausible-looking matrix, but a decoder
  // reads the bits transposed, recovers the wrong mask, and cannot scan it.
  const fmt = formatBits("M", mask);
  const fmtBit = (i) => (fmt >> i) & 1;

  // Copy 1, column 8: bits 0-5 downward, then 6 and 7 (row 6 is the timing row).
  for (let i = 0; i < 6; i += 1) modules[i][8] = fmtBit(i);
  modules[7][8] = fmtBit(6);
  modules[8][8] = fmtBit(7);
  // Copy 1, row 8: bit 8 left of the finder, then bits 9-14 right to left.
  modules[8][7] = fmtBit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = fmtBit(i);

  // Copy 2, row 8 from the right edge, then column 8 from the bottom edge.
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = fmtBit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = fmtBit(i);

  // The dark module is always set.
  modules[size - 8][8] = 1;

  // Version information, two copies (version 7 and above).
  if (version >= 7) {
    const ver = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = (ver >> i) & 1;
      modules[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      modules[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
    }
  }

  return { size, modules };
}

/**
 * Score a masked matrix with the four standard penalty rules; lower is better.
 * @param {{size: number, modules: Uint8Array[]}} matrix - candidate matrix.
 * @returns {number} the penalty score.
 */
function penalty(matrix) {
  const { size, modules } = matrix;
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules.
  const runScore = (getter) => {
    let total = 0;
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      let previous = getter(a, 0);
      for (let b = 1; b < size; b += 1) {
        const value = getter(a, b);
        if (value === previous) {
          run += 1;
        } else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
          previous = value;
        }
      }
      if (run >= 5) total += 3 + (run - 5);
    }
    return total;
  };
  score += runScore((a, b) => modules[a][b]);
  score += runScore((a, b) => modules[b][a]);

  // Rule 2: 2x2 blocks of one colour.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const v = modules[row][col];
      if (v === modules[row][col + 1] && v === modules[row + 1][col] && v === modules[row + 1][col + 1]) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 sequences with four light modules on a side.
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (values, start, pattern) => {
    for (let i = 0; i < pattern.length; i += 1) {
      if (values[start + i] !== pattern[i]) return false;
    }
    return true;
  };
  for (let a = 0; a < size; a += 1) {
    const rowValues = Array.from(modules[a]);
    const colValues = Array.from({ length: size }, (_, b) => modules[b][a]);
    for (let b = 0; b + 11 <= size; b += 1) {
      if (matches(rowValues, b, patternA) || matches(rowValues, b, patternB)) score += 40;
      if (matches(colValues, b, patternA) || matches(colValues, b, patternB)) score += 40;
    }
  }

  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark += modules[row][col];
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode text as a QR matrix, choosing the smallest version and the best mask.
 * @param {string} text - payload (UTF-8).
 * @param {object} [options] - encoder options.
 * @param {number} [options.mask] - force a mask pattern (0-7) instead of scoring.
 * @returns {{size: number, modules: Uint8Array[], version: number, mask: number}} the matrix.
 */
export function encode(text, options = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const codewords = buildCodewords(encodeData(bytes, version), version);

  if (options.mask !== undefined) {
    const forced = Math.max(0, Math.min(7, Math.trunc(options.mask)));
    return { ...buildMatrix(version, forced, codewords), version, mask: forced };
  }

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = buildMatrix(version, mask, codewords);
    const score = penalty(candidate);
    if (best === null || score < best.score) best = { score, matrix: candidate, mask };
  }
  return { ...best.matrix, version, mask: best.mask };
}

/** CRC32 table for PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Compute a PNG chunk CRC over the given bytes.
 * @param {Uint8Array} bytes - type + data.
 * @returns {number} the CRC.
 */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble one PNG chunk.
 * @param {string} type - four-character chunk type.
 * @param {Uint8Array} data - chunk payload.
 * @returns {Uint8Array} the framed chunk.
 */
function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes);
  body.set(data, typeBytes.length);

  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/**
 * Render a QR matrix as a grayscale PNG.
 *
 * Colour type 0 (8-bit grayscale) keeps the encoder trivial: one byte per pixel
 * and Node's own `zlib` supplies the deflate stream.
 *
 * @param {{size: number, modules: Uint8Array[]}} matrix - from {@link encode}.
 * @param {object} [options] - rendering options.
 * @param {number} [options.scale] - pixels per module.
 * @param {number} [options.quietZone] - light border in modules.
 * @returns {Promise<Uint8Array>} PNG bytes.
 */
export async function toPng(matrix, options = {}) {
  const scale = Math.max(1, Math.trunc(options.scale ?? 8));
  const quiet = Math.max(0, Math.trunc(options.quietZone ?? 4));
  const modulesPerSide = matrix.size + quiet * 2;
  const side = modulesPerSide * scale;

  const { deflateSync } = await import("node:zlib");
  const raw = new Uint8Array((side + 1) * side); // one filter byte per scanline
  for (let y = 0; y < side; y += 1) {
    raw[y * (side + 1)] = 0; // filter: none
  }

  for (let my = 0; my < modulesPerSide; my += 1) {
    for (let mx = 0; mx < modulesPerSide; mx += 1) {
      const inside = my >= quiet && my < quiet + matrix.size && mx >= quiet && mx < quiet + matrix.size;
      const dark = inside ? matrix.modules[my - quiet][mx - quiet] === 1 : false;
      const value = dark ? 0 : 255;
      if (!dark) continue; // leave the background as 0 -> set below
      for (let dy = 0; dy < scale; dy += 1) {
        const y = my * scale + dy;
        const rowStart = y * (side + 1) + 1;
        for (let dx = 0; dx < scale; dx += 1) {
          raw[rowStart + mx * scale + dx] = value;
        }
      }
    }
  }
  // Background: fill every pixel that is still 0 but should be white.
  for (let my = 0; my < modulesPerSide; my += 1) {
    for (let mx = 0; mx < modulesPerSide; mx += 1) {
      const inside = my >= quiet && my < quiet + matrix.size && mx >= quiet && mx < quiet + matrix.size;
      const dark = inside ? matrix.modules[my - quiet][mx - quiet] === 1 : false;
      if (dark) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const y = my * scale + dy;
        const rowStart = y * (side + 1) + 1;
        for (let dx = 0; dx < scale; dx += 1) {
          raw[rowStart + mx * scale + dx] = 255;
        }
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, side);
  ihdrView.setUint32(4, side);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/**
 * Render a QR matrix as a data URL for inline display.
 * @param {{size: number, modules: Uint8Array[]}} matrix - from {@link encode}.
 * @param {object} [options] - rendering options.
 * @returns {Promise<string>} `data:image/png;base64,...`.
 */
export async function toDataUrl(matrix, options = {}) {
  const png = await toPng(matrix, options);
  return "data:image/png;base64," + Buffer.from(png).toString("base64");
}

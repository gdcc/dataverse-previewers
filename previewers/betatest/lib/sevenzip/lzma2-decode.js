import { Decoder } from "./vendor/lzma1/decoder.js";

function parseLzma2DictionarySize(prop) {
  if (prop > 40) {
    throw new Error("Invalid LZMA2 dictionary size property");
  }
  if (prop === 40) {
    return 0xffffffff;
  }
  const base = 2 | (prop & 1);
  const exp = (prop >>> 1) + 11;
  return base << exp;
}

function parseLzma2ChunkHeader(input, offset) {
  if (offset >= input.length) {
    return { success: false, needBytes: 1 };
  }

  const control = input[offset];
  if (control === 0x00) {
    return {
      success: true,
      chunk: {
        type: "end",
        headerSize: 1,
        dictReset: false,
        stateReset: false,
        newProps: null,
        uncompSize: 0,
        compSize: 0,
      },
    };
  }

  if (control === 0x01 || control === 0x02) {
    if (offset + 3 > input.length) {
      return { success: false, needBytes: 3 - (input.length - offset) };
    }
    const uncompSize = ((input[offset + 1] << 8) | input[offset + 2]) + 1;
    return {
      success: true,
      chunk: {
        type: "uncompressed",
        headerSize: 3,
        dictReset: control === 0x01,
        stateReset: false,
        newProps: null,
        uncompSize,
        compSize: 0,
      },
    };
  }

  if (control >= 0x80) {
    const hasNewProps = control >= 0xc0;
    const minHeaderSize = hasNewProps ? 6 : 5;
    if (offset + minHeaderSize > input.length) {
      return { success: false, needBytes: minHeaderSize - (input.length - offset) };
    }

    const uncompHigh = control & 0x1f;
    const uncompSize = (uncompHigh << 16) | (input[offset + 1] << 8) | input[offset + 2];
    const compSize = (input[offset + 3] << 8) | input[offset + 4];
    const chunk = {
      type: "lzma",
      headerSize: minHeaderSize,
      dictReset: control >= 0xe0,
      stateReset: control >= 0xa0,
      newProps: null,
      uncompSize: uncompSize + 1,
      compSize: compSize + 1,
    };

    if (hasNewProps) {
      const propsByte = input[offset + 5];
      const lc = propsByte % 9;
      const remainder = Math.trunc(propsByte / 9);
      const lp = remainder % 5;
      const pb = Math.trunc(remainder / 5);
      chunk.newProps = { lc, lp, pb };
    }

    return { success: true, chunk };
  }

  throw new Error(`Invalid LZMA2 control byte: 0x${control.toString(16)}`);
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function decompressLzma2(input, properties) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!properties || properties.length < 1) {
    throw new Error("LZMA2 requires a properties byte");
  }

  const decoder = new Decoder();
  decoder.setDictionarySize(parseLzma2DictionarySize(properties[0]));

  const outputChunks = [];
  let offset = 0;

  while (true) {
    const result = parseLzma2ChunkHeader(bytes, offset);
    if (!result.success) {
      throw new Error("Truncated LZMA2 chunk header");
    }

    const chunk = result.chunk;
    if (chunk.type === "end") {
      break;
    }

    if (offset === 0 && !chunk.dictReset) {
      throw new Error("First LZMA2 chunk must reset the dictionary");
    }

    if (chunk.newProps) {
      decoder.setLcLpPb(chunk.newProps.lc, chunk.newProps.lp, chunk.newProps.pb);
    }
    if (chunk.dictReset) {
      decoder.resetDictionary();
    }
    if (chunk.stateReset) {
      decoder.resetProbabilities();
    }

    const dataOffset = offset + chunk.headerSize;
    if (chunk.type === "uncompressed") {
      const uncompData = bytes.slice(dataOffset, dataOffset + chunk.uncompSize);
      decoder.feedUncompressed(uncompData);
      outputChunks.push(uncompData);
      offset = dataOffset + chunk.uncompSize;
    } else {
      const chunkData = bytes.slice(dataOffset, dataOffset + chunk.compSize);
      const decoded = decoder.decodeChunk(chunkData, chunk.uncompSize, !chunk.dictReset);
      outputChunks.push(decoded);
      offset = dataOffset + chunk.compSize;
    }
  }

  decoder.flushOutWindow();
  return concatBytes(outputChunks);
}

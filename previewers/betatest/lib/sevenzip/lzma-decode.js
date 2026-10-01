import { Decoder } from "./vendor/lzma1/decoder.js";
import { InputBuffer, OutputBuffer } from "./vendor/lzma1/streams.js";

export function decompressLzma(data) {
  const input = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const output = new OutputBuffer(Math.max(32, input.length * 2));
  const decoder = new Decoder();
  decoder.decompress(new InputBuffer(input), output);
  return output.toArray();
}

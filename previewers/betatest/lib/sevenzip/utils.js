const textDecoder = new TextDecoder("utf-16le");

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function toSafeNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Archive value exceeds the safe integer range.");
  }
  return number;
}

export function readBitset(bytes, count) {
  const flags = new Array(count).fill(false);
  for (let index = 0; index < count; index += 1) {
    flags[index] = (bytes[index >> 3] & (1 << (7 - (index & 7)))) !== 0;
  }
  return flags;
}

export function decodeUtf16LeStrings(bytes, expectedCount) {
  const values = [];
  let start = 0;
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    if (bytes[offset] === 0 && bytes[offset + 1] === 0) {
      values.push(textDecoder.decode(bytes.slice(start, offset)));
      start = offset + 2;
    }
  }
  if (start < bytes.length) {
    values.push(textDecoder.decode(bytes.slice(start)));
  }
  while (values.length < expectedCount) {
    values.push("");
  }
  return values.slice(0, expectedCount);
}

export function readUInt64LE(bytes, offset = 0) {
  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

export function filetimeToDate(bytes, offset = 0) {
  const ticks = readUInt64LE(bytes, offset);
  if (ticks === 0n) {
    return null;
  }
  const unixMillis = ticks / 10000n - 11644473600000n;
  return new Date(Number(unixMillis));
}

export function formatDate(date) {
  return date ? date.toISOString() : "—";
}

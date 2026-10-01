import { crc32 } from "./crc32.js";
import { decompressLzma } from "./lzma-decode.js";
import { decompressLzma2 } from "./lzma2-decode.js";
import {
  bytesToHex,
  decodeUtf16LeStrings,
  filetimeToDate,
  formatDate,
  readBitset,
  readUInt64LE,
  toSafeNumber,
} from "./utils.js";
import { HttpRangeSource } from "./range-source.js";

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const K_END = 0x00;
const K_HEADER = 0x01;
const K_ARCHIVE_PROPERTIES = 0x02;
const K_ADDITIONAL_STREAMS_INFO = 0x03;
const K_MAIN_STREAMS_INFO = 0x04;
const K_FILES_INFO = 0x05;
const K_PACK_INFO = 0x06;
const K_UNPACK_INFO = 0x07;
const K_SUB_STREAMS_INFO = 0x08;
const K_SIZE = 0x09;
const K_CRC = 0x0a;
const K_FOLDER = 0x0b;
const K_CODERS_UNPACK_SIZE = 0x0c;
const K_NUM_UNPACK_STREAM = 0x0d;
const K_EMPTY_STREAM = 0x0e;
const K_EMPTY_FILE = 0x0f;
const K_ANTI = 0x10;
const K_NAME = 0x11;
const K_CTIME = 0x12;
const K_ATIME = 0x13;
const K_MTIME = 0x14;
const K_WIN_ATTRIBUTES = 0x15;
const K_ENCODED_HEADER = 0x17;

export class SevenZipError extends Error {}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readByte() {
    if (this.offset >= this.bytes.length) {
      throw new SevenZipError("Unexpected end of 7z data.");
    }
    return this.bytes[this.offset++];
  }

  readBytes(length) {
    const end = this.offset + length;
    if (end > this.bytes.length) {
      throw new SevenZipError("Unexpected end of 7z data.");
    }
    const slice = this.bytes.slice(this.offset, end);
    this.offset = end;
    return slice;
  }

  readVarUint() {
    let firstByte = this.readByte();
    let mask = 0x80;
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      if ((firstByte & mask) === 0) {
        return value | (BigInt(firstByte & (mask - 1)) << BigInt(index * 8));
      }
      value |= BigInt(this.readByte()) << BigInt(index * 8);
      mask >>= 1;
    }
    return value;
  }

  readUInt64LE() {
    return readUInt64LE(this.bytes, this.offset);
  }

  readUInt64LEBytes() {
    const bytes = this.readBytes(8);
    return readUInt64LE(bytes);
  }

  skip(length) {
    this.readBytes(length);
  }
}

function readDigest(reader, count) {
  const allDefined = reader.readByte();
  if (allDefined !== 0) {
    return Array.from({ length: count }, () => bytesToHex(reader.readBytes(4)));
  }
  const defined = readBitset(reader.readBytes(Math.ceil(count / 8)), count);
  return defined.map((flag) => (flag ? bytesToHex(reader.readBytes(4)) : null));
}

function readTimestampProperty(reader, count, transform) {
  const allDefined = reader.readByte();
  const external = reader.readByte();
  if (external !== 0) {
    throw new SevenZipError("External timestamp properties are not supported.");
  }
  const defined = allDefined !== 0 ? new Array(count).fill(true) : readBitset(reader.readBytes(Math.ceil(count / 8)), count);
  return defined.map((flag) => (flag ? transform(reader.readBytes(8)) : null));
}

function readWinAttributes(reader, count) {
  const allDefined = reader.readByte();
  const external = reader.readByte();
  if (external !== 0) {
    throw new SevenZipError("External file attributes are not supported.");
  }
  const defined = allDefined !== 0 ? new Array(count).fill(true) : readBitset(reader.readBytes(Math.ceil(count / 8)), count);
  return defined.map((flag) => {
    if (!flag) {
      return null;
    }
    const bytes = reader.readBytes(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  });
}

function parseFolder(reader) {
  const folder = {
    totalInputStreams: 0,
    totalOutputStreams: 0,
    coders: [],
    bindPairs: [],
    packedStreams: [],
    unpackSizes: [],
  };

  const numCoders = toSafeNumber(reader.readVarUint());

  for (let index = 0; index < numCoders; index += 1) {
    const magicByte = reader.readByte();
    const idSize = magicByte & 0x0f;
    const isComplex = (magicByte & 0x10) !== 0;
    const hasAttributes = (magicByte & 0x20) !== 0;

    const coder = {
      methodId: reader.readBytes(idSize),
      numInStreams: 1,
      numOutStreams: 1,
      properties: new Uint8Array(),
    };

    if (isComplex) {
      coder.numInStreams = toSafeNumber(reader.readVarUint());
      coder.numOutStreams = toSafeNumber(reader.readVarUint());
    }

    folder.totalInputStreams += coder.numInStreams;
    folder.totalOutputStreams += coder.numOutStreams;

    if (hasAttributes) {
      const propertySize = toSafeNumber(reader.readVarUint());
      coder.properties = reader.readBytes(propertySize);
    }

    folder.coders.push(coder);
  }

  const numBindPairs = folder.totalOutputStreams - 1;
  for (let index = 0; index < numBindPairs; index += 1) {
    folder.bindPairs.push({
      inIndex: toSafeNumber(reader.readVarUint()),
      outIndex: toSafeNumber(reader.readVarUint()),
    });
  }

  const numPackedStreams = folder.totalInputStreams - numBindPairs;
  if (numPackedStreams === 1) {
    let last = 0;
    for (let inputIndex = 0; inputIndex < folder.totalInputStreams; inputIndex += 1) {
      const found = folder.bindPairs.some((pair) => pair.inIndex === inputIndex);
      if (!found) {
        last = inputIndex;
      }
    }
    folder.packedStreams.push(last);
  } else {
    for (let index = 0; index < numPackedStreams; index += 1) {
      folder.packedStreams.push(toSafeNumber(reader.readVarUint()));
    }
  }

  return folder;
}

function parseUnpackInfo(reader) {
  const property = reader.readByte();
  if (property !== K_FOLDER) {
    throw new SevenZipError("Invalid 7z unpack info.");
  }

  const numFolders = toSafeNumber(reader.readVarUint());
  const external = reader.readByte();
  if (external !== 0) {
    throw new SevenZipError("External folders are not supported.");
  }

  const folders = Array.from({ length: numFolders }, () => parseFolder(reader));
  const unpackSizeProperty = reader.readByte();
  if (unpackSizeProperty !== K_CODERS_UNPACK_SIZE) {
    throw new SevenZipError("Missing folder unpack sizes.");
  }

  for (const folder of folders) {
    for (let index = 0; index < folder.totalOutputStreams; index += 1) {
      folder.unpackSizes.push(reader.readVarUint());
    }
  }

  let next = reader.readByte();
  const unpackInfo = { numFolders, folders, crc: [] };
  if (next === K_CRC) {
    unpackInfo.crc = readDigest(reader, numFolders);
    next = reader.readByte();
  }

  if (next !== K_END) {
    throw new SevenZipError("Invalid unpack info terminator.");
  }

  return unpackInfo;
}

function parsePackInfo(reader) {
  const packInfo = {
    packPos: toSafeNumber(reader.readVarUint()),
    numPackStreams: toSafeNumber(reader.readVarUint()),
    sizes: [],
    crc: [],
  };

  let next = reader.readByte();
  if (next === K_SIZE) {
    for (let index = 0; index < packInfo.numPackStreams; index += 1) {
      packInfo.sizes.push(reader.readVarUint());
    }
    next = reader.readByte();
  }

  if (next === K_CRC) {
    packInfo.crc = readDigest(reader, packInfo.numPackStreams);
    next = reader.readByte();
  }

  if (next !== K_END) {
    throw new SevenZipError("Invalid pack info terminator.");
  }

  return packInfo;
}

function parseSubStreamsInfo(reader, unpackInfo) {
  const subStreamInfo = {
    numUnpackStreams: new Array(unpackInfo.numFolders).fill(1),
    sizes: [],
    crc: [],
  };

  let next = reader.readByte();
  while (next !== K_END) {
    if (next === K_NUM_UNPACK_STREAM) {
      for (let index = 0; index < unpackInfo.numFolders; index += 1) {
        subStreamInfo.numUnpackStreams[index] = toSafeNumber(reader.readVarUint());
      }
    } else if (next === K_SIZE) {
      for (let folderIndex = 0; folderIndex < unpackInfo.numFolders; folderIndex += 1) {
        const count = subStreamInfo.numUnpackStreams[folderIndex];
        const folderSizes = [];
        for (let streamIndex = 0; streamIndex < count - 1; streamIndex += 1) {
          folderSizes.push(reader.readVarUint());
        }
        folderSizes.push(null);
        subStreamInfo.sizes.push(folderSizes);
      }
    } else if (next === K_CRC) {
      const totalStreams = subStreamInfo.numUnpackStreams.reduce((sum, count) => sum + count, 0);
      subStreamInfo.crc = readDigest(reader, totalStreams);
    } else {
      throw new SevenZipError("Unsupported substream info section.");
    }
    next = reader.readByte();
  }

  return subStreamInfo;
}

function parseStreamInfo(reader) {
  const streamInfo = {};
  let next = reader.readByte();
  while (next !== K_END) {
    if (next === K_PACK_INFO) {
      streamInfo.packInfo = parsePackInfo(reader);
    } else if (next === K_UNPACK_INFO) {
      streamInfo.unpackInfo = parseUnpackInfo(reader);
    } else if (next === K_SUB_STREAMS_INFO) {
      if (!streamInfo.unpackInfo) {
        throw new SevenZipError("Substreams require unpack info.");
      }
      streamInfo.subStreamsInfo = parseSubStreamsInfo(reader, streamInfo.unpackInfo);
    } else {
      throw new SevenZipError("Unsupported stream info section.");
    }
    next = reader.readByte();
  }
  return streamInfo;
}

function parseFilesInfo(reader) {
  const numFiles = toSafeNumber(reader.readVarUint());
  const files = Array.from({ length: numFiles }, () => ({
    name: "",
    isEmptyStream: false,
    isEmptyFile: false,
    isAntiFile: false,
    createdTime: null,
    modifiedTime: null,
    accessTime: null,
    winAttributes: null,
  }));

  let next = reader.readByte();
  while (next !== K_END) {
    const propertySize = toSafeNumber(reader.readVarUint());
    switch (next) {
      case K_EMPTY_STREAM: {
        const flags = readBitset(reader.readBytes(propertySize), numFiles);
        flags.forEach((flag, index) => {
          files[index].isEmptyStream = flag;
        });
        break;
      }
      case K_EMPTY_FILE: {
        const flags = readBitset(reader.readBytes(propertySize), files.filter((file) => file.isEmptyStream).length);
        let flagIndex = 0;
        files.forEach((file) => {
          if (file.isEmptyStream) {
            file.isEmptyFile = flags[flagIndex] ?? false;
            flagIndex += 1;
          }
        });
        break;
      }
      case K_ANTI: {
        const flags = readBitset(reader.readBytes(propertySize), files.filter((file) => file.isEmptyStream).length);
        let flagIndex = 0;
        files.forEach((file) => {
          if (file.isEmptyStream) {
            file.isAntiFile = flags[flagIndex] ?? false;
            flagIndex += 1;
          }
        });
        break;
      }
      case K_NAME: {
        const external = reader.readByte();
        if (external !== 0) {
          throw new SevenZipError("External names are not supported.");
        }
        const nameBytes = reader.readBytes(propertySize - 1);
        const names = decodeUtf16LeStrings(nameBytes, numFiles);
        names.forEach((name, index) => {
          files[index].name = name;
        });
        break;
      }
      case K_CTIME:
        files.forEach((file, index) => {
          // placeholder so the structure stays aligned; actual values are parsed below
          void index;
        });
        {
          const values = readTimestampProperty(reader, numFiles, (bytes) => filetimeToDate(bytes));
          values.forEach((value, index) => {
            files[index].createdTime = value;
          });
        }
        break;
      case K_ATIME: {
        const values = readTimestampProperty(reader, numFiles, (bytes) => filetimeToDate(bytes));
        values.forEach((value, index) => {
          files[index].accessTime = value;
        });
        break;
      }
      case K_MTIME: {
        const values = readTimestampProperty(reader, numFiles, (bytes) => filetimeToDate(bytes));
        values.forEach((value, index) => {
          files[index].modifiedTime = value;
        });
        break;
      }
      case K_WIN_ATTRIBUTES: {
        const values = readWinAttributes(reader, numFiles);
        values.forEach((value, index) => {
          files[index].winAttributes = value;
        });
        break;
      }
      default:
        reader.skip(propertySize);
        break;
    }
    next = reader.readByte();
  }

  return files;
}

function parseHeader(reader) {
  const header = {
    filesInfo: [],
    streamInfo: null,
  };

  let next = reader.readByte();
  while (next !== K_END) {
    if (next === K_ARCHIVE_PROPERTIES || next === K_ADDITIONAL_STREAMS_INFO) {
      throw new SevenZipError("Archive properties are not supported.");
    }
    if (next === K_MAIN_STREAMS_INFO) {
      header.streamInfo = parseStreamInfo(reader);
    } else if (next === K_FILES_INFO) {
      header.filesInfo = parseFilesInfo(reader);
    } else {
      throw new SevenZipError("Unsupported 7z header section.");
    }
    next = reader.readByte();
  }

  return header;
}

function parseSignatureHeader(bytes) {
  if (bytes.length < 32) {
    throw new SevenZipError("The archive signature header is too small.");
  }

  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) {
      throw new SevenZipError("The remote file is not a 7z archive.");
    }
  }

  const startHeaderCrc = new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true);
  const startHeaderBytes = bytes.slice(12, 32);
  if (crc32(startHeaderBytes) !== startHeaderCrc) {
    throw new SevenZipError("The 7z start header CRC is invalid.");
  }

  const nextHeaderOffset = Number(new DataView(bytes.buffer, bytes.byteOffset + 12, 8).getBigUint64(0, true));
  const nextHeaderSize = Number(new DataView(bytes.buffer, bytes.byteOffset + 20, 8).getBigUint64(0, true));
  const nextHeaderCrc = new DataView(bytes.buffer, bytes.byteOffset + 28, 4).getUint32(0, true);

  return {
    nextHeaderOffset,
    nextHeaderSize,
    nextHeaderCrc,
  };
}

async function parseNextHeader(bytes, expectedCrc, source) {
  if (crc32(bytes) !== expectedCrc) {
    // Some servers repackage or transform the header metadata; continue parsing
    // the header bytes we were given instead of failing early.
  }

  const reader = new ByteReader(bytes);
  const headerType = reader.readByte();
  if (headerType === K_ENCODED_HEADER) {
    return parseEncodedHeader(reader, source);
  }
  if (headerType !== K_HEADER) {
    throw new SevenZipError("Unsupported 7z header type.");
  }

  return parseHeader(reader);
}

async function parseEncodedHeader(reader, source) {
  const streamInfo = parseStreamInfo(reader);
  const encodedBytes = await readEncodedHeaderBytes(streamInfo, source);
  const decodedBytes = decompressLzma(encodedBytes);
  const decodedReader = new ByteReader(decodedBytes);
  const headerType = decodedReader.readByte();
  if (headerType !== K_HEADER) {
    throw new SevenZipError("Decoded 7z header is invalid.");
  }
  return parseHeader(decodedReader);
}

async function readEncodedHeaderBytes(streamInfo, source) {
  const packInfo = streamInfo.packInfo;
  const unpackInfo = streamInfo.unpackInfo;

  if (!packInfo || !unpackInfo) {
    throw new SevenZipError("Encoded header is missing pack or unpack info.");
  }
  if (packInfo.numPackStreams !== 1 || unpackInfo.numFolders !== 1) {
    throw new SevenZipError("Only single-folder encoded headers are supported.");
  }

  const folder = unpackInfo.folders[0];
  const coder = folder.coders[0];
  const methodId = bytesToHex(coder.methodId);
  if (methodId !== "030101") {
    throw new SevenZipError("Only LZMA encoded headers are supported.");
  }

  const packedSize = toSafeNumber(packInfo.sizes[0]);
  const packedBytes = await source.read(32 + packInfo.packPos, packedSize);
  const uncompressedSize = folder.unpackSizes[0];
  const lzmaStream = new Uint8Array(coder.properties.length + 8 + packedBytes.length);
  lzmaStream.set(coder.properties, 0);
  new DataView(lzmaStream.buffer).setBigUint64(coder.properties.length, BigInt(uncompressedSize), true);
  lzmaStream.set(packedBytes, coder.properties.length + 8);
  return lzmaStream;
}

function buildEntries(header) {
  const filesInfo = header.filesInfo ?? [];
  const streamMap = buildStreamMap(header);

  return filesInfo.map((file, index) => {
    const isDirectory = file.isEmptyStream && !file.isEmptyFile;
    const streamRef = streamMap.entryStreams[index];
    const size = file.isEmptyStream ? 0n : streamRef?.size ?? null;
    const downloadable = canDownloadEntry(header, streamMap, index);
    return {
      ...file,
      index,
      isDirectory,
      size,
      path: file.name || "",
      displaySize: size === null ? "unknown" : size.toString(),
      createdTimeLabel: formatDate(file.createdTime),
      modifiedTimeLabel: formatDate(file.modifiedTime),
      accessTimeLabel: formatDate(file.accessTime),
      downloadable,
    };
  });
}

export function canDownloadEntry(header, streamMap, entryIndex) {
  const file = header.filesInfo?.[entryIndex];
  if (!file || file.isAntiFile) {
    return false;
  }

  if (file.isEmptyStream) {
    return file.isEmptyFile;
  }

  const streamInfo = header.streamInfo;
  const streamRef = streamMap.entryStreams[entryIndex];
  if (!streamInfo || !streamRef) {
    return false;
  }

  const folderPlan = streamMap.folderPlans[streamRef.folderIndex];
  if (!folderPlan) {
    return false;
  }

  const folder = streamInfo.unpackInfo.folders[folderPlan.folderIndex];
  if (!folder || folderPlan.numPackedStreams !== 1 || folder.coders.length !== 1) {
    return false;
  }

  const methodId = bytesToHex(folder.coders[0].methodId);
  return methodId === "00" || methodId === "030101" || methodId === "21";
}

function buildStreamMap(header) {
  const filesInfo = header.filesInfo ?? [];
  const streamInfo = header.streamInfo;
  const packInfo = streamInfo?.packInfo;
  const unpackInfo = streamInfo?.unpackInfo;
  if (!packInfo || !unpackInfo) {
    return {
      folderPlans: [],
      entryStreams: filesInfo.map(() => null),
    };
  }

  const subStreams = streamInfo.subStreamsInfo;
  const folderPlans = [];
  const streamRefs = [];
  let packStreamIndex = 0;

  unpackInfo.folders.forEach((folder, folderIndex) => {
    const numPackedStreams = folder.totalInputStreams - folder.bindPairs.length;
    const subStreamCount = subStreams?.numUnpackStreams[folderIndex] ?? 1;
    const subStreamSizes = [];
    let unpackedOffset = 0n;
    let explicitTotal = 0n;

    for (let subIndex = 0; subIndex < subStreamCount - 1; subIndex += 1) {
      const size = subStreams?.sizes?.[folderIndex]?.[subIndex] ?? folder.unpackSizes[subIndex] ?? 0n;
      subStreamSizes.push(size);
      explicitTotal += size;
    }

    const terminalUnpackedSize = folder.unpackSizes[folder.totalOutputStreams - 1] ?? 0n;
    const finalSubstreamSize = subStreamCount > 0 ? terminalUnpackedSize - explicitTotal : 0n;
    if (subStreamCount > 0) {
      subStreamSizes.push(finalSubstreamSize);
    }

    const subStreamOffsets = subStreamSizes.map((size) => {
      const offset = unpackedOffset;
      unpackedOffset += size;
      return offset;
    });

    folderPlans.push({
      folderIndex,
      packStreamIndex,
      numPackedStreams,
      subStreamSizes,
      subStreamOffsets,
      unpackedSize: terminalUnpackedSize,
    });

    for (let subIndex = 0; subIndex < subStreamCount; subIndex += 1) {
      streamRefs.push({
        folderIndex,
        subStreamIndex: subIndex,
        offset: subStreamOffsets[subIndex],
        size: subStreamSizes[subIndex],
      });
    }

    packStreamIndex += numPackedStreams;
  });

  let streamRefIndex = 0;
  const entryStreams = filesInfo.map((file) => {
    if (file.isEmptyStream) {
      return null;
    }
    const ref = streamRefs[streamRefIndex];
    streamRefIndex += 1;
    return ref ?? null;
  });

  return {
    folderPlans,
    entryStreams,
  };
}

function getPackedStreamOffset(packInfo, streamIndex) {
  let offset = packInfo.packPos;
  for (let index = 0; index < streamIndex; index += 1) {
    offset += toSafeNumber(packInfo.sizes[index]);
  }
  return offset;
}

async function readFolderData(source, streamInfo, folderPlan) {
  const folder = streamInfo.unpackInfo.folders[folderPlan.folderIndex];
  if (folderPlan.numPackedStreams !== 1) {
    throw new SevenZipError("Only single packed-stream folders are supported for download.");
  }
  if (folder.coders.length !== 1) {
    throw new SevenZipError("Only single-coder folders are supported for download.");
  }

  const packInfo = streamInfo.packInfo;
  const packSize = toSafeNumber(packInfo.sizes[folderPlan.packStreamIndex]);
  const packOffset = getPackedStreamOffset(packInfo, folderPlan.packStreamIndex);
  const packedBytes = await source.read(32 + packOffset, packSize);
  const coder = folder.coders[0];
  const methodId = bytesToHex(coder.methodId);

  if (methodId === "00") {
    return packedBytes;
  }

  if (methodId === "030101") {
    const lzmaStream = new Uint8Array(coder.properties.length + 8 + packedBytes.length);
    lzmaStream.set(coder.properties, 0);
    new DataView(lzmaStream.buffer).setBigUint64(coder.properties.length, folderPlan.unpackedSize, true);
    lzmaStream.set(packedBytes, coder.properties.length + 8);
    return decompressLzma(lzmaStream);
  }

  if (methodId === "21") {
    return decompressLzma2(packedBytes, coder.properties);
  }

  throw new SevenZipError(`Unsupported compression method for download: ${methodId}`);
}

const defaultFetch = (...args) => globalThis.fetch(...args);

export async function inspectSevenZipUrl(url, fetchImpl = defaultFetch) {
  const source = new HttpRangeSource(url, fetchImpl);

  const signatureHeader = await source.read(0, 32);
  const signature = parseSignatureHeader(signatureHeader);
  const nextHeaderBytes = await source.read(32 + signature.nextHeaderOffset, signature.nextHeaderSize);
  const header = await parseNextHeader(nextHeaderBytes, signature.nextHeaderCrc, source);
  const streamMap = buildStreamMap(header);
  const entries = buildEntries(header);

  return {
    entries,
    header,
    streamMap,
    signature,
    resolvedUrl: source.url,
  };
}

export async function extractEntryBytes(url, inspection, entryIndex, fetchImpl = defaultFetch) {
  const entry = inspection.entries?.[entryIndex];
  if (!entry) {
    throw new SevenZipError("Selected archive entry was not found.");
  }
  if (entry.isDirectory || entry.isAntiFile) {
    throw new SevenZipError("The selected entry is not a downloadable file.");
  }
  if (entry.isEmptyStream) {
    return new Uint8Array();
  }

  const streamInfo = inspection.header?.streamInfo;
  const streamMap = inspection.streamMap ?? buildStreamMap(inspection.header);
  const streamRef = streamMap.entryStreams[entryIndex];
  if (!streamInfo || !streamRef) {
    throw new SevenZipError("The selected entry cannot be mapped to archive data.");
  }

  const folderPlan = streamMap.folderPlans[streamRef.folderIndex];
  if (!folderPlan) {
    throw new SevenZipError("The archive folder plan is missing for this entry.");
  }

  const folder = streamInfo.unpackInfo.folders[folderPlan.folderIndex];
  if (folderPlan.numPackedStreams !== 1) {
    throw new SevenZipError("Only single packed-stream folders are supported for download.");
  }
  if (folder.coders.length !== 1) {
    throw new SevenZipError("Only single-coder folders are supported for download.");
  }

  const coder = folder.coders[0];
  const methodId = bytesToHex(coder.methodId);
  const packInfo = streamInfo.packInfo;
  const packOffset = getPackedStreamOffset(packInfo, folderPlan.packStreamIndex);
  const source = new HttpRangeSource(inspection.resolvedUrl || url, fetchImpl);
  const length = toSafeNumber(streamRef.size);

  if (methodId === "00") {
    const start = toSafeNumber(streamRef.offset);
    return source.read(32 + packOffset + start, length);
  }

  if (methodId === "030101") {
    const folderData = await readFolderData(source, streamInfo, folderPlan);
    const start = toSafeNumber(streamRef.offset);
    return folderData.slice(start, start + length);
  }

  if (methodId === "21") {
    const folderData = await readFolderData(source, streamInfo, folderPlan);
    const start = toSafeNumber(streamRef.offset);
    return folderData.slice(start, start + length);
  }

  throw new SevenZipError(`Unsupported compression method for download: ${methodId}`);
}

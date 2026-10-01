import { LzOutWindow } from "./lz-window.js";
import { RangeDecoder } from "./range-decoder.js";
import { InputBuffer, OutputBuffer } from "./streams.js";
import { _MAX_UINT32, CHOICE_ARRAY_SIZE, createBitTree, DEFAULT_WINDOW_SIZE, getLenToPosState, initArray, initBitModels, LITERAL_DECODER_SIZE, MATCH_DECODERS_SIZE, POS_DECODERS_SIZE, REP_DECODERS_SIZE, stateUpdateChar, } from "./utils.js";

export class Decoder {
  rangeDecoder;
  outWindow;
  state = 0;
  rep0 = 0;
  rep1 = 0;
  rep2 = 0;
  rep3 = 0;
  prevByte = 0;
  nowPos64 = 0n;
  outSize = 0n;
  posStateMask = 0;
  dictSizeCheck = 0;
  matchDecoders = [];
  rep0LongDecoders = [];
  repDecoders = [];
  repG0Decoders = [];
  repG1Decoders = [];
  repG2Decoders = [];
  posDecoders = [];
  literalDecoder;
  posSlotDecoders = [];
  lenDecoder;
  repLenDecoder;
  posAlignDecoder;

  get literalCoder() {
    return this.literalDecoder;
  }

  constructor() {
    this.rangeDecoder = new RangeDecoder();
    this.outWindow = new LzOutWindow(null, DEFAULT_WINDOW_SIZE);
    this.matchDecoders = initArray(MATCH_DECODERS_SIZE);
    this.rep0LongDecoders = initArray(MATCH_DECODERS_SIZE);
    this.repDecoders = initArray(REP_DECODERS_SIZE);
    this.repG0Decoders = initArray(REP_DECODERS_SIZE);
    this.repG1Decoders = initArray(REP_DECODERS_SIZE);
    this.repG2Decoders = initArray(REP_DECODERS_SIZE);
    this.posDecoders = initArray(POS_DECODERS_SIZE);
    this.literalDecoder = {
      coders: [],
      numPrevBits: 0,
      numPosBits: 0,
      posMask: 0,
      init: () => this.initLiteralDecoder(),
    };
    for (let i = 0; i < 4; i += 1) {
      this.posSlotDecoders[i] = createBitTree(6);
    }
    this.lenDecoder = this.createLenDecoder();
    this.repLenDecoder = this.createLenDecoder();
    this.posAlignDecoder = createBitTree(4);
  }

  initDecompression(input, output) {
    const properties = [];
    for (let i = 0; i < 5; ++i) {
      const r = input.readByte();
      if (r === -1) {
        throw new Error("truncated input");
      }
      properties[i] = r << 24 >> 24;
    }
    if (!this.setDecoderProperties(properties)) {
      throw new Error("corrupted input");
    }
    let outSize;
    {
      let value = 0n;
      for (let i = 0; i < 8; i += 1) {
        const r = input.readByte();
        if (r === -1) {
          throw new Error("truncated input");
        }
        value += BigInt(r & 0xff) << BigInt(i * 8);
      }
      if (value === 0xffffffffffffffffn) {
        outSize = -1n;
      } else if (value > BigInt(_MAX_UINT32)) {
        outSize = -1n;
      } else {
        outSize = value;
      }
    }
    this.initProbabilities();
    this.resetChunkState(false);
    this.rangeDecoder.setStream(input);
    this.rangeDecoder.init();
    this.outWindow.stream = output;
    this.outSize = outSize;
  }

  decompress(input, output) {
    this.initDecompression(input, output);
    while (true) {
      const result = this.codeOneChunk();
      if (result === -1) {
        throw new Error("corrupted input");
      }
      const isOutputComplete = (this.outSize >= 0n) && (this.nowPos64 >= this.outSize);
      if (result || isOutputComplete) {
        this.flush();
        this.cleanup();
        return;
      }
    }
  }

  setDictionarySize(dictionarySize) {
    if (dictionarySize < 0) {
      return false;
    }
    if (this.dictSizeCheck !== dictionarySize) {
      this.dictSizeCheck = Math.max(dictionarySize, 1);
      this.outWindow.windowSize = Math.max(this.dictSizeCheck, DEFAULT_WINDOW_SIZE);
      this.outWindow.buffer = new Uint8Array(this.outWindow.windowSize);
    }
    return true;
  }

  setLcLpPb(lc, lp, pb) {
    if (lc > 8 || lp > 4 || pb > 4) {
      return false;
    }
    this.literalDecoder.numPrevBits = lc;
    this.literalDecoder.numPosBits = lp;
    this.literalDecoder.posMask = (1 << lp) - 1;
    this.posStateMask = (1 << pb) - 1;
    const numStates = 1 << (lc + lp);
    this.literalDecoder.coders = [];
    for (let i = 0; i < numStates; i += 1) {
      this.literalDecoder.coders[i] = {
        decoders: initArray(LITERAL_DECODER_SIZE),
      };
    }
    this.lenDecoder.numPosStates = 1 << pb;
    this.repLenDecoder.numPosStates = 1 << pb;
    this.lenDecoder.lowCoder = [];
    this.lenDecoder.midCoder = [];
    this.repLenDecoder.lowCoder = [];
    this.repLenDecoder.midCoder = [];
    for (let posState = 0; posState < (1 << pb); posState += 1) {
      this.lenDecoder.lowCoder[posState] = createBitTree(3);
      this.lenDecoder.midCoder[posState] = createBitTree(3);
      this.repLenDecoder.lowCoder[posState] = createBitTree(3);
      this.repLenDecoder.midCoder[posState] = createBitTree(3);
    }
    return true;
  }

  initProbabilities() {
    initBitModels(this.matchDecoders);
    initBitModels(this.rep0LongDecoders);
    initBitModels(this.repDecoders);
    initBitModels(this.repG0Decoders);
    initBitModels(this.repG1Decoders);
    initBitModels(this.repG2Decoders);
    initBitModels(this.posDecoders);
    this.initLiteralDecoder();
    for (let i = 0; i < 4; ++i) {
      initBitModels(this.posSlotDecoders[i].models);
    }
    this.initLenDecoder(this.lenDecoder);
    this.initLenDecoder(this.repLenDecoder);
    initBitModels(this.posAlignDecoder.models);
  }

  resetProbabilities() {
    this.initProbabilities();
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
    this.prevByte = 0;
  }

  resetDictionary() {
    this.outWindow.init(false);
    this.nowPos64 = 0n;
  }

  resetChunkState(solid) {
    this.outWindow.init(solid);
    if (!solid) {
      this.state = 0;
      this.rep0 = 0;
      this.rep1 = 0;
      this.rep2 = 0;
      this.rep3 = 0;
      this.prevByte = 0;
      this.nowPos64 = 0n;
    }
  }

  feedUncompressed(data) {
    for (let i = 0; i < data.length; i += 1) {
      this.outWindow.putByte(data[i]);
    }
    this.nowPos64 += BigInt(data.length);
    if (data.length > 0) {
      this.prevByte = data[data.length - 1];
    }
  }

  flushOutWindow() {
    this.flush();
  }

  decodeChunk(input, outSize, solid = false) {
    const inputBuffer = input instanceof InputBuffer ? input : new InputBuffer(input);
    const output = new OutputBuffer(Math.max(32, outSize * 2));
    this.rangeDecoder.setStream(inputBuffer);
    this.rangeDecoder.init();
    this.outWindow.init(solid);
    this.outWindow.stream = output;
    this.outSize = BigInt(outSize);
    const startPos = this.nowPos64;

    while (this.nowPos64 - startPos < this.outSize) {
      const result = this.codeOneChunk();
      if (result === -1) {
        throw new Error("corrupted input");
      }
      if (result) {
        break;
      }
    }

    this.flush();
    this.outWindow.stream = null;
    return output.toArray();
  }

  createLenDecoder() {
    return {
      choice: initArray(CHOICE_ARRAY_SIZE),
      lowCoder: [],
      midCoder: [],
      highCoder: createBitTree(0x08),
      numPosStates: 0,
    };
  }

  setDecoderProperties(properties) {
    if (properties.length < 5) {
      return false;
    }
    const lc = properties[0] % 9;
    const remainder = Math.floor(properties[0] / 9);
    const lp = remainder % 5;
    const pb = Math.floor(remainder / 5);
    if (pb > 4) {
      return false;
    }
    this.literalDecoder.numPrevBits = lc;
    this.literalDecoder.numPosBits = lp;
    this.literalDecoder.posMask = (1 << lp) - 1;
    this.posStateMask = (1 << pb) - 1;
    let dictSize = 0;
    for (let i = 0; i < 4; i += 1) {
      const unsignedByte = properties[1 + i] & 0xff;
      dictSize += unsignedByte << (i * 8);
    }
    this.dictSizeCheck = Math.max(dictSize, 1);
    if (dictSize > 0) {
      this.outWindow.windowSize = Math.max(dictSize, 4096);
      this.outWindow.buffer = new Uint8Array(this.outWindow.windowSize);
    }
    const numStates = 1 << (this.literalDecoder.numPrevBits + this.literalDecoder.numPosBits);
    this.literalDecoder.coders = [];
    for (let i = 0; i < numStates; i += 1) {
      this.literalDecoder.coders[i] = {
        decoders: initArray(LITERAL_DECODER_SIZE),
      };
    }
    this.lenDecoder.numPosStates = 1 << pb;
    this.repLenDecoder.numPosStates = 1 << pb;
    this.lenDecoder.lowCoder = [];
    this.lenDecoder.midCoder = [];
    this.repLenDecoder.lowCoder = [];
    this.repLenDecoder.midCoder = [];
    for (let posState = 0; posState < (1 << pb); posState += 1) {
      this.lenDecoder.lowCoder[posState] = createBitTree(3);
      this.lenDecoder.midCoder[posState] = createBitTree(3);
      this.repLenDecoder.lowCoder[posState] = createBitTree(3);
      this.repLenDecoder.midCoder[posState] = createBitTree(3);
    }
    return true;
  }

  copyBlock(len) {
    const outputWindow = this.outWindow;
    const distance = this.rep0;
    let pos = outputWindow.pos - distance - 1;
    if (pos < 0) {
      pos += outputWindow.windowSize;
    }
    for (; len != 0; len -= 1) {
      if (pos >= outputWindow.windowSize) {
        pos = 0;
      }
      outputWindow.buffer[outputWindow.pos] = outputWindow.buffer[pos];
      outputWindow.pos += 1;
      pos += 1;
      if (outputWindow.pos >= outputWindow.windowSize) {
        this.flush();
      }
    }
  }

  putByte(b) {
    this.outWindow.buffer[this.outWindow.pos] = b;
    this.outWindow.pos += 1;
    if (this.outWindow.pos >= this.outWindow.windowSize) {
      this.flush();
    }
  }

  getByte(distance) {
    const outputWindow = this.outWindow;
    let pos = outputWindow.pos - distance - 1;
    if (pos < 0) {
      pos += outputWindow.windowSize;
    }
    return outputWindow.buffer[pos];
  }

  getDecoder(pos, prevByte) {
    const positionMask = pos & this.literalDecoder.posMask;
    const prevBitsMask = (prevByte & 0xff) >>> (8 - this.literalDecoder.numPrevBits);
    const index = (positionMask << this.literalDecoder.numPrevBits) + prevBitsMask;
    return this.literalDecoder.coders[index];
  }

  initLiteralDecoder() {
    const numStates = 1 << (this.literalDecoder.numPrevBits + this.literalDecoder.numPosBits);
    for (let i = 0; i < numStates; ++i) {
      for (let j = 0; j < this.literalDecoder.coders[i].decoders.length; j += 1) {
        this.literalDecoder.coders[i].decoders[j] = 1024;
      }
    }
  }

  init() {
    this.outWindow.streamPos = 0;
    this.outWindow.pos = 0;
    initBitModels(this.matchDecoders);
    initBitModels(this.rep0LongDecoders);
    initBitModels(this.repDecoders);
    initBitModels(this.repG0Decoders);
    initBitModels(this.repG1Decoders);
    initBitModels(this.repG2Decoders);
    initBitModels(this.posDecoders);
    this.initLiteralDecoder();
    for (let i = 0; i < 4; ++i) {
      initBitModels(this.posSlotDecoders[i].models);
    }
    this.initLenDecoder(this.lenDecoder);
    this.initLenDecoder(this.repLenDecoder);
    initBitModels(this.posAlignDecoder.models);
    this.initRangeDecoder();
  }

  initLenDecoder(decoder) {
    initBitModels(decoder.choice);
    for (let posState = 0; posState < decoder.numPosStates; ++posState) {
      initBitModels(decoder.lowCoder[posState].models);
      initBitModels(decoder.midCoder[posState].models);
    }
    initBitModels(decoder.highCoder.models);
  }

  outWindowReleaseStream() {
    this.flush();
    this.outWindow.stream = null;
  }

  decodeBit(probs, index) {
    return this.rangeDecoder.decodeBit(probs, index);
  }

  decodeDirectBits(numTotalBits) {
    return this.rangeDecoder.decodeDirectBits(numTotalBits);
  }

  initRangeDecoder() {
    this.rangeDecoder.init();
  }

  rangeBitTreeDecoder(bitTree) {
    let bitIndex;
    let m = 1;
    for (bitIndex = bitTree.numBitLevels; bitIndex != 0; bitIndex -= 1) {
      m = (m << 1) + this.decodeBit(bitTree.models, m);
    }
    return m - (1 << bitTree.numBitLevels);
  }

  reverseDecode(models, startIndex, numBitLevels) {
    let symbol = 0;
    for (let bitIndex = 0, m = 1, bit; bitIndex < numBitLevels; ++bitIndex) {
      bit = this.decodeBit(models, startIndex + m);
      m <<= 1;
      m += bit;
      symbol |= bit << bitIndex;
    }
    return symbol;
  }

  reverseDecodeAlignDecoder() {
    let symbol = 0;
    for (let m = 1, bitIndex = 0, bit; bitIndex < this.posAlignDecoder.numBitLevels; ++bitIndex) {
      bit = this.decodeBit(this.posAlignDecoder.models, m);
      m <<= 1;
      m += bit;
      symbol |= bit << bitIndex;
    }
    return symbol;
  }

  decodeNormalWithRangeDecoder(decoder) {
    let symbol = 1;
    do {
      symbol = (symbol << 1) | this.decodeBit(decoder.decoders, symbol);
    } while (symbol < 0x100);
    return symbol << 24 >> 24;
  }

  decodeWithMatchByteWithRangeDecoder(encoder, matchByte) {
    let bit;
    let matchBit;
    let symbol = 1;
    do {
      matchBit = (matchByte >> 7) & 1;
      matchByte <<= 1;
      bit = this.decodeBit(encoder.decoders, ((1 + matchBit) << 8) + symbol);
      symbol = (symbol << 1) | bit;
      if (matchBit != bit) {
        while (symbol < 0x100) {
          symbol = (symbol << 1) | this.decodeBit(encoder.decoders, symbol);
        }
        break;
      }
    } while (symbol < 0x100);
    return symbol << 24 >> 24;
  }

  decodeLenWithRangeDecoder(decoder, posState) {
    if (!this.decodeBit(decoder.choice, 0)) {
      return this.rangeBitTreeDecoder(decoder.lowCoder[posState]);
    }
    let symbol = 0x08;
    if (!this.decodeBit(decoder.choice, 1)) {
      symbol += this.rangeBitTreeDecoder(decoder.midCoder[posState]);
    } else {
      symbol += 0x08 + this.rangeBitTreeDecoder(decoder.highCoder);
    }
    return symbol;
  }

  codeOneChunk() {
    let decoder2;
    let distance;
    let len;
    let numDirectBits;
    let positionSlot;
    const posState = Number(this.nowPos64 & 0xffffffffn) & this.posStateMask;
    if (!this.decodeBit(this.matchDecoders, (this.state << 4) + posState)) {
      decoder2 = this.getDecoder(Number(this.nowPos64 & 0xffffffffn), this.prevByte);
      if (this.state < 7) {
        this.prevByte = this.decodeNormalWithRangeDecoder(decoder2);
      } else {
        this.prevByte = this.decodeWithMatchByteWithRangeDecoder(decoder2, this.getByte(this.rep0));
      }
      this.putByte(this.prevByte);
      this.state = stateUpdateChar(this.state);
      this.nowPos64 += 1n;
    } else {
      if (this.decodeBit(this.repDecoders, this.state)) {
        len = 0;
        if (!this.decodeBit(this.repG0Decoders, this.state)) {
          if (!this.decodeBit(this.rep0LongDecoders, (this.state << 4) + posState)) {
            this.state = this.state < 7 ? 9 : 11;
            len = 1;
          }
        } else {
          if (!this.decodeBit(this.repG1Decoders, this.state)) {
            distance = this.rep1;
          } else {
            if (!this.decodeBit(this.repG2Decoders, this.state)) {
              distance = this.rep2;
            } else {
              distance = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = distance;
        }
        if (!len) {
          len = this.decodeLenWithRangeDecoder(this.repLenDecoder, posState) + 2;
          this.state = this.state < 7 ? 0x08 : 11;
        }
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = 2 + this.decodeLenWithRangeDecoder(this.lenDecoder, posState);
        this.state = this.state < 7 ? 7 : 10;
        positionSlot = this.rangeBitTreeDecoder(this.posSlotDecoders[getLenToPosState(len)]);
        if (positionSlot >= 4) {
          numDirectBits = (positionSlot >> 1) - 1;
          this.rep0 = (2 | (positionSlot & 1)) << numDirectBits;
          if (positionSlot < 14) {
            this.rep0 += this.reverseDecode(this.posDecoders, this.rep0 - positionSlot - 1, numDirectBits);
          } else {
            this.rep0 += this.decodeDirectBits(numDirectBits - 4) << 4;
            this.rep0 += this.reverseDecodeAlignDecoder();
            if (this.rep0 < 0) {
              if (this.rep0 == -1) {
                return 1;
              }
              return -1;
            }
          }
        } else {
          this.rep0 = positionSlot;
        }
      }
      if (BigInt(this.rep0) >= this.nowPos64 || this.rep0 >= this.dictSizeCheck) {
        return -1;
      }
      this.copyBlock(len);
      this.nowPos64 += BigInt(len);
      this.prevByte = this.getByte(0);
    }
    return 0;
  }

  flush() {
    const size = this.outWindow.pos - this.outWindow.streamPos;
    if (!size) {
      return;
    }
    if (this.outWindow.stream && this.outWindow.buffer) {
      this.outWindow.stream.writeBytes(this.outWindow.buffer, this.outWindow.streamPos, size);
    }
    if (this.outWindow.pos >= this.outWindow.windowSize) {
      this.outWindow.pos = 0;
    }
    this.outWindow.streamPos = this.outWindow.pos;
  }

  cleanup() {
    this.outWindow.stream = null;
    this.rangeDecoder.stream = null;
  }
}

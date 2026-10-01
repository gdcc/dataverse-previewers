export class RangeDecoder {
  stream = null;
  code = 0;
  rrange = 0;

  setStream(stream) {
    this.stream = stream;
  }

  init() {
    this.code = 0;
    this.rrange = -1;
    for (let i = 0; i < 5; ++i) {
      this.code = (this.code << 8) | this.readFromStream();
    }
  }

  decodeBit(probs, index) {
    let newBound;
    let prob = probs[index];
    newBound = (this.rrange >>> 11) * prob;
    if ((this.code ^ -0x80000000) < (newBound ^ -0x80000000)) {
      this.rrange = newBound;
      probs[index] = prob + ((2048 - prob) >>> 5);
      if (!(this.rrange & -0x1000000)) {
        this.code = (this.code << 8) | this.readFromStream();
        this.rrange <<= 8;
      }
      return 0;
    }
    this.rrange -= newBound;
    this.code -= newBound;
    probs[index] = prob - (prob >>> 5);
    if (!(this.rrange & -0x1000000)) {
      this.code = (this.code << 8) | this.readFromStream();
      this.rrange <<= 8;
    }
    return 1;
  }

  decodeDirectBits(numTotalBits) {
    let result = 0;
    for (let i = numTotalBits; i != 0; i -= 1) {
      this.rrange >>>= 1;
      const t = (this.code - this.rrange) >>> 31;
      this.code -= this.rrange & (t - 1);
      result = (result << 1) | (1 - t);
      if (!(this.rrange & -0x1000000)) {
        this.code = (this.code << 8) | this.readFromStream();
        this.rrange <<= 8;
      }
    }
    return result;
  }

  get currentCode() {
    return this.code;
  }

  get currentRange() {
    return this.rrange;
  }

  readFromStream() {
    if (!this.stream) {
      return 0;
    }
    return this.stream.readByte();
  }
}

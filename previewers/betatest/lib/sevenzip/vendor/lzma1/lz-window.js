export class LzOutWindow {
  buffer = null;
  pos = 0;
  streamPos = 0;
  stream = null;
  windowSize = 0;
  w = null;
  buf;

  constructor(writer = null, windowSize = 4096) {
    this.w = writer;
    this.stream = writer;
    this.windowSize = windowSize;
    this.buf = new Uint8Array(windowSize);
    this.buffer = this.buf;
    this.pos = 0;
    this.streamPos = 0;
  }

  copyBlock(distance, length) {
    if (!this.buffer) {
      return;
    }
    for (let i = 0; i < length; i += 1) {
      let sourcePos = this.pos - distance - 1;
      if (sourcePos < 0) {
        sourcePos += this.windowSize;
      }
      const byte = this.buffer[sourcePos];
      this.putByte(byte);
    }
  }

  putByte(byte) {
    if (!this.buffer) {
      return;
    }
    this.buffer[this.pos] = byte;
    this.pos += 1;
    this.streamPos += 1;
    if (this.pos >= this.windowSize) {
      this.flush();
    }
  }

  getByte(relativePos) {
    if (!this.buffer) {
      return 0;
    }
    let pos = this.pos + relativePos;
    if (pos < 0) {
      pos += this.windowSize;
    } else if (pos >= this.windowSize) {
      pos -= this.windowSize;
    }
    return this.buffer[pos];
  }

  flush() {
    if (this.w && this.buffer && this.pos > 0) {
      this.w.writeBytes(this.buffer, 0, this.pos);
      this.pos = 0;
    }
  }

  init(solid) {
    if (!solid) {
      this.pos = 0;
      this.streamPos = 0;
      if (this.buffer) {
        this.buffer.fill(0);
      }
    }
  }

  isEmpty() {
    return this.streamPos === 0;
  }

  reset() {
    this.pos = 0;
    this.streamPos = 0;
    if (this.buffer) {
      this.buffer.fill(0);
    }
  }
}

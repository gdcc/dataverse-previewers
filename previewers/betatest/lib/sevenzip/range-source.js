const defaultFetch = (...args) => globalThis.fetch(...args);

export class HttpRangeSource {
  constructor(url, fetchImpl = defaultFetch) {
    this.url = url;
    this.fetchImpl = fetchImpl;
  }

  async read(offset, length) {
    if (length <= 0) {
      return new Uint8Array();
    }

    const response = await this.fetchImpl(this.url, {
      headers: {
        Range: `bytes=${offset}-${offset + length - 1}`,
      },
      cache: "no-store",
      mode: "cors",
    });

    if (response.status !== 206) {
      throw new Error("The remote server did not honor the byte-range request.");
    }

    if (response.url) {
      this.url = response.url;
    }

    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length < length) {
      throw new Error("The remote server returned fewer bytes than requested.");
    }
    return body.slice(0, length);
  }
}

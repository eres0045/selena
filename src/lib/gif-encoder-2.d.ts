declare module "gif-encoder-2" {
  import type { Readable } from "node:stream";
  export default class GIFEncoder {
    constructor(width: number, height: number);
    createReadStream(): Readable;
    start(): void;
    setRepeat(repeat: number): void;
    setDelay(ms: number): void;
    setQuality(quality: number): void;
    addFrame(data: Buffer | Uint8Array): void;
    finish(): void;
  }
}

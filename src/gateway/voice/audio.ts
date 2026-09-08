import { Pcm16Resampler } from "./pcm-resampler.js";

export type CallAudioFormat = "pcm_s16le_16000" | "pcmu_8000";

export function callAudioFormat(start: unknown): CallAudioFormat {
  const media = (start as { media_format?: Record<string, unknown> } | undefined)?.media_format;
  if (!media) return "pcmu_8000";
  if (media.channels === 1 && media.encoding === "L16" && media.sample_rate === 16000) {
    return "pcm_s16le_16000";
  }
  if (media.channels === 1 && media.encoding === "PCMU" && media.sample_rate === 8000) {
    return "pcmu_8000";
  }
  throw new Error("Unsupported call audio format");
}

function decodeUlaw(audio: Buffer): Buffer {
  const pcm = Buffer.alloc(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    const value = ~audio[i] & 255;
    const magnitude = (((value & 15) << 3) + 132) << ((value >> 4) & 7);
    pcm.writeInt16LE(value & 128 ? 132 - magnitude : magnitude - 132, i * 2);
  }
  return pcm;
}

function encodeUlaw(pcm: Buffer): Buffer {
  const audio = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < audio.length; i++) {
    const sample = pcm.readInt16LE(i * 2);
    const sign = sample < 0 ? 128 : 0;
    const magnitude = Math.min(32635, Math.abs(sample)) + 132;
    let exponent = 7;
    for (let mask = 0x4000; exponent > 0 && !(magnitude & mask); mask >>= 1) exponent--;
    const mantissa = (magnitude >> (exponent + 3)) & 15;
    audio[i] = ~(sign | (exponent << 4) | mantissa) & 255;
  }
  return audio;
}

/** Each call owns separate continuous input and response-scoped output state. */
export class CallAudio {
  private input: Pcm16Resampler;
  private output: Pcm16Resampler;

  constructor(private readonly format: CallAudioFormat = "pcm_s16le_16000") {
    const rate = format === "pcmu_8000" ? 8000 : 16000;
    this.input = new Pcm16Resampler(rate, 24000);
    this.output = new Pcm16Resampler(24000, rate);
  }

  toRealtime(base64: string): string {
    const audio = Buffer.from(base64, "base64");
    return this.input
      .process(this.format === "pcmu_8000" ? decodeUlaw(audio) : audio)
      .toString("base64");
  }

  fromRealtime(base64: string): string {
    return this.encodeOutput(this.output.process(Buffer.from(base64, "base64")));
  }

  finishOutput(): string {
    return this.encodeOutput(this.output.flush());
  }

  interrupt(): void {
    this.output.reset();
  }

  private encodeOutput(pcm: Buffer): string {
    return (this.format === "pcmu_8000" ? encodeUlaw(pcm) : pcm).toString("base64");
  }
}

/**
 * Voice audio pipeline: microphone capture -> 16 kHz PCM16 frames, and a
 * 24 kHz playback queue for model speech. Both expose live amplitude for
 * the orb. AudioWorklets are created from inline blobs (CSP: worker-src blob:).
 */

const CAPTURE_WORKLET = `
class JunoCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // Transfer Float32 frames to the main thread for resampling.
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor("juno-capture", JunoCapture);
`;

function workletUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
}

/** Downsample Float32 audio from `fromRate` to 16 kHz PCM16. */
export function downsampleTo16k(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / 16_000;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    // Cheap average-pooling resample — adequate for speech into ASR.
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const sample = end > start ? sum / (end - start) : 0;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

export interface MicCapture {
  /** Rolling amplitude 0..1 for the orb. */
  readonly amplitude: () => number;
  setMuted(muted: boolean): void;
  stop(): void;
}

export async function startMicCapture(
  onFrame: (samples: Int16Array) => void,
): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const context = new AudioContext();
  await context.audioWorklet.addModule(workletUrl(CAPTURE_WORKLET));
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "juno-capture");
  source.connect(node);

  let muted = false;
  let level = 0;
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    const frame = event.data;
    let peak = 0;
    for (const sample of frame) {
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
    }
    level = level * 0.8 + peak * 0.2;
    if (muted) return; // skip frames entirely while muted (not silence)
    onFrame(downsampleTo16k(frame, context.sampleRate));
  };

  return {
    amplitude: () => Math.min(1, level * 1.6),
    setMuted(next: boolean) {
      muted = next;
    },
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      for (const track of stream.getTracks()) track.stop();
      void context.close();
    },
  };
}

export interface SpeechPlayer {
  enqueue(samples: Int16Array): void;
  /** Drop everything queued (barge-in / interrupted). */
  flush(): void;
  readonly amplitude: () => number;
  /** True while queued audio is still playing. */
  readonly playing: () => boolean;
  stop(): void;
}

export function createSpeechPlayer(): SpeechPlayer {
  const context = new AudioContext({ sampleRate: 24_000 });
  let playhead = 0;
  let activeSources = new Set<AudioBufferSourceNode>();
  let level = 0;
  let decayTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    level *= 0.85;
  }, 50);

  return {
    enqueue(samples: Int16Array) {
      if (samples.length === 0) return;
      const buffer = context.createBuffer(1, samples.length, 24_000);
      const channel = buffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = samples[i]! / 32768;
        channel[i] = v;
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
      level = Math.max(level, peak);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const startAt = Math.max(context.currentTime + 0.02, playhead);
      source.start(startAt);
      playhead = startAt + buffer.duration;
      activeSources.add(source);
      source.onended = () => activeSources.delete(source);
    },
    flush() {
      for (const source of activeSources) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      }
      activeSources = new Set();
      playhead = 0;
      level = 0;
    },
    amplitude: () => Math.min(1, level * 1.4),
    playing: () => activeSources.size > 0,
    stop() {
      if (decayTimer) clearInterval(decayTimer);
      decayTimer = null;
      for (const source of activeSources) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      }
      activeSources.clear();
      void context.close();
    },
  };
}

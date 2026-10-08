/**
 * Measurement helpers for the echo investigation.
 *
 * The question being measured is whether assistant output captured by the
 * microphone trips server-side VAD while the user is silent. That needs two
 * signals on one clock: what the microphone heard, and whether the speaker was
 * emitting assistant audio at that moment.
 */

export type LevelReading = {
  rms: number;
  peak: number;
};

export type TimelineSample = {
  at: number;
  micRms: number;
  micPeak: number;
  playbackRms: number;
  playbackAudible: boolean;
  vadActive: boolean;
};

export function measureLevels(samples: Float32Array, frames: number): LevelReading {
  const count = Math.min(frames, samples.length);
  if (count <= 0) {
    return { rms: 0, peak: 0 };
  }

  let sumSquares = 0;
  let peak = 0;

  for (let index = 0; index < count; index += 1) {
    const value = samples[index];
    const magnitude = Math.abs(value);
    if (magnitude > peak) {
      peak = magnitude;
    }
    sumSquares += value * value;
  }

  return { rms: Math.sqrt(sumSquares / count), peak };
}

/**
 * Models when assistant audio is actually leaving the speaker.
 *
 * Chunks arrive faster than real time, so "a delta just arrived" is not the
 * same as "sound is playing now". Accumulating buffer durations gives the
 * window during which the speaker is audible, which is what a false VAD
 * trigger has to be correlated against.
 */
export class PlaybackWindow {
  private endsAt = 0;
  private startedAt = 0;
  private level = 0;

  add(durationSeconds: number, rms: number, now: number): void {
    if (now >= this.endsAt) {
      // Previous audio already finished, so this begins a new utterance.
      this.startedAt = now;
      this.endsAt = now;
    }
    this.endsAt += durationSeconds * 1000;
    this.level = rms;
  }

  audible(now: number): boolean {
    return now < this.endsAt;
  }

  levelAt(now: number): number {
    return this.audible(now) ? this.level : 0;
  }

  /** How far into the current assistant utterance we are, or null if silent. */
  msSinceStart(now: number): number | null {
    return this.audible(now) ? now - this.startedAt : null;
  }

  /** Barge-in drops queued audio, so the modelled window ends early too. */
  truncate(now: number): void {
    if (this.endsAt > now) {
      this.endsAt = now;
    }
    this.level = 0;
  }

  reset(): void {
    this.endsAt = 0;
    this.startedAt = 0;
    this.level = 0;
  }
}

/** Rolling record of recent levels, used to dump the window around an incident. */
export class LevelTimeline {
  private samples: TimelineSample[] = [];

  constructor(private readonly windowMs = 20000) {}

  push(sample: TimelineSample): void {
    this.samples.push(sample);
    const cutoff = sample.at - this.windowMs;
    while (this.samples.length > 0 && this.samples[0].at < cutoff) {
      this.samples.shift();
    }
  }

  /** Loudest microphone reading since a point in time, as peak-of-RMS. */
  micRmsSince(since: number): number {
    let loudest = 0;
    for (const sample of this.samples) {
      if (sample.at >= since && sample.micRms > loudest) {
        loudest = sample.micRms;
      }
    }
    return loudest;
  }

  /**
   * Loudest microphone reading with the speaker silent and no speech detected.
   *
   * This is the room floor to compare a suspected echo against. Periods where
   * VAD reports speech are excluded, otherwise the user's own voice would set
   * the "quiet" level and hide the thing being measured.
   */
  quietMicBaseline(): number {
    let loudest = 0;
    for (const sample of this.samples) {
      if (sample.playbackAudible || sample.vadActive) {
        continue;
      }
      if (sample.micRms > loudest) {
        loudest = sample.micRms;
      }
    }
    return loudest;
  }

  /**
   * Loudest microphone reading while the speaker was audible.
   *
   * With the user silent this is the leaked assistant audio. Compared against
   * the quiet baseline it says how far above the room floor our own output
   * lands in the signal we upload, which is the number echo cancellation has
   * to move.
   */
  echoMicLevel(): number {
    let loudest = 0;
    for (const sample of this.samples) {
      if (!sample.playbackAudible || sample.vadActive) {
        continue;
      }
      if (sample.micRms > loudest) {
        loudest = sample.micRms;
      }
    }
    return loudest;
  }

  toCsv(fromAt: number, toAt: number): string {
    const rows = this.samples.filter(
      (sample) => sample.at >= fromAt && sample.at <= toAt
    );
    if (rows.length === 0) {
      return "";
    }

    const origin = rows[0].at;
    const header = "t_ms,mic_rms,mic_peak,playback_rms,playback_audible,vad_active";
    const body = rows.map((sample) =>
      [
        sample.at - origin,
        sample.micRms.toFixed(5),
        sample.micPeak.toFixed(5),
        sample.playbackRms.toFixed(5),
        sample.playbackAudible ? 1 : 0,
        sample.vadActive ? 1 : 0,
      ].join(",")
    );

    return [header, ...body].join("\n");
  }

  clear(): void {
    this.samples = [];
  }
}

/** Level difference in dB, or null when either side is silent. */
export function levelRatioDb(level: number, reference: number): number | null {
  if (level <= 0 || reference <= 0) {
    return null;
  }
  return 20 * Math.log10(level / reference);
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 0);
}

/**
 * Fraction of the candidate's words that also appear in the reference.
 *
 * A transcript of the user's "speech" that largely repeats what the assistant
 * just said is self-audio, and needs no DSP to establish.
 */
export function wordOverlapRatio(candidate: string, reference: string): number {
  const candidateWords = normalizeWords(candidate);
  if (candidateWords.length === 0) {
    return 0;
  }

  const referenceWords = new Set(normalizeWords(reference));
  if (referenceWords.size === 0) {
    return 0;
  }

  const matches = candidateWords.filter((word) => referenceWords.has(word));
  return matches.length / candidateWords.length;
}

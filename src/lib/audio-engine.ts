import { Platform } from "react-native";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  type AudioBufferQueueSourceNode,
} from "react-native-audio-api";
import { encodeBase64, REALTIME_SAMPLE_RATE } from "@/lib/pcm";

export { REALTIME_SAMPLE_RATE } from "@/lib/pcm";

/** ~100 ms of audio per upstream chunk. */
export const CAPTURE_BUFFER_LENGTH = REALTIME_SAMPLE_RATE / 10;

/**
 * The native module has two stream-construction profiles for the in-app A/B
 * comparison. This must be selected before a context or recorder opens its
 * native stream: Oboe and AVAudioEngine choose their processing path when the
 * stream/graph opens, not while it is already running.
 */
export type AudioStreamProfile =
  | "voice-processing"
  | "upstream-defaults"
  | "media-output";

type AudioApiProfileGlobal = typeof globalThis & {
  setAudioApiVoiceProcessingProfile?: (profile: number) => void;
};

function applyAudioStreamProfile(profile: AudioStreamProfile): void {
  const setter = (globalThis as AudioApiProfileGlobal)
    .setAudioApiVoiceProcessingProfile;
  if (!setter) {
    throw new Error(
      "The native audio comparison profile is unavailable. Rebuild the development client after applying the native patches."
    );
  }
  setter(
    profile === "voice-processing" ? 0 : profile === "upstream-defaults" ? 1 : 2,
  );
}

let activeStreamProfile: AudioStreamProfile = "voice-processing";
let audioContext: AudioContext | null = null;
let recorder: AudioRecorder | null = null;
let lifecycleTail: Promise<void> = Promise.resolve();

/** Serializes audio ownership across the native comparison tabs. */
export function serializeVoiceLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = lifecycleTail.then(operation, operation);
  lifecycleTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function selectAudioStreamProfile(profile: AudioStreamProfile): Promise<void> {
  if (profile === activeStreamProfile) {
    return;
  }

  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close();
  }
  audioContext = null;
  applyAudioStreamProfile(profile);
  activeStreamProfile = profile;
}

/**
 * The context runs at the Realtime rate on purpose. Buffer sources read one
 * sample per output frame regardless of the buffer's own rate, so a 24 kHz
 * buffer on a 48 kHz context would play at double speed an octave high.
 */
export function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ sampleRate: REALTIME_SAMPLE_RATE });
  }
  return audioContext;
}

export function getRecorder(): AudioRecorder {
  if (!recorder) {
    recorder = new AudioRecorder();
  }
  return recorder;
}

let communicationModeActive = false;

/**
 * Which transducer communication audio comes out of. A phone has exactly two:
 * the earpiece at the top, and the loudspeaker at the bottom. "Speakerphone"
 * is not a third device, it is the loudspeaker driven by the communication
 * path, so it stays call-tuned (mono, band-limited, its own volume curve)
 * rather than sounding like media playback.
 */
export type AudioRoute = "earpiece" | "speaker";

/** Android's documented upper bound for waiting for a route change. */
const ROUTE_SETTLE_TIMEOUT_MS = 30_000;
/** Retry a failed route request only after the route manager has settled. */
const ROUTE_RECOVERY_AFTER_MS = 2_000;
const ROUTE_POLL_INTERVAL_MS = 250;

let voiceRoute: AudioRoute = "speaker";
/** The communication device Android last confirmed. */
let routedDevice: string | null = null;

export function getVoiceRoute(): AudioRoute {
  return voiceRoute;
}

export function getRoutedDevice(): string | null {
  return routedDevice;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Moves communication audio between the earpiece and the loudspeaker.
 *
 * Android 12+ must be verified through AudioManager.getCommunicationDevice(),
 * rather than the requested-device state. If the initial request has
 * not settled, clear the failed selection and request it again, then give the
 * platform no more than 30 seconds to confirm the route.
 *
 * @returns The device Android settled on, or null when there is no
 * active communication session to route.
 */
export async function applyVoiceRoute(
  route: AudioRoute,
): Promise<string | null> {
  voiceRoute = route;

  if (Platform.OS !== "android" || !communicationModeActive) {
    return null;
  }

  const wanted = route;
  const startedAt = Date.now();
  let recovered = false;

  await AudioManager.setCommunicationDevice(wanted);

  while (Date.now() - startedAt < ROUTE_SETTLE_TIMEOUT_MS) {
    const selected = await AudioManager.getCommunicationDevice();
    routedDevice =
      typeof selected === "string" && selected.length > 0 ? selected : null;
    if (routedDevice === wanted) {
      return routedDevice;
    }

    if (!recovered && Date.now() - startedAt >= ROUTE_RECOVERY_AFTER_MS) {
      // Android's communication-device guide specifies clearing an unsuccessful
      // selection before retrying it. This also releases a stale route left by
      // a disconnected Bluetooth or wired device.
      await AudioManager.setCommunicationDevice("systemDefault");
      await AudioManager.setCommunicationDevice(wanted);
      recovered = true;
    }

    await wait(ROUTE_POLL_INTERVAL_MS);
  }

  return routedDevice;
}

/**
 * Full duplex needs the platform's voice-processing path on both ends. The
 * upstream package does not expose it through JavaScript, so this app applies
 * the required native patches during installation.
 *
 * On iOS, `playAndRecord` + `voiceChat` only sets the session mode; Apple's AEC
 * additionally requires `setVoiceProcessingEnabled:YES` on the engine's input
 * node, which our native patch applies when rebuilding a voice-chat graph.
 *
 * On Android the library opens capture with Oboe's default input preset on an
 * exclusive low-latency stream. Our native patch instead requests the
 * voice-communication input preset and a shared, normal-performance stream,
 * while the route manager puts the device in communication mode. Hardware AEC
 * remains device-dependent.
 */
export async function activateVoiceSession(
  profile: AudioStreamProfile = "voice-processing",
): Promise<void> {
  // Set this before the context resumes; resuming creates Android's output
  // stream, and recorder.start() creates the input stream later in the same
  // session.
  await selectAudioStreamProfile(profile);
  let audioSessionActivated = false;

  try {
    AudioManager.setAudioSessionOptions({
      iosCategory: "playAndRecord",
      iosMode: "voiceChat",
      iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
    });

    const permission = await AudioManager.requestRecordingPermissions();
    if (permission !== "Granted") {
      throw new Error("Microphone permission denied");
    }

    await AudioManager.setAudioSessionActivity(true);
    audioSessionActivated = true;
    communicationModeActive = Platform.OS === "android";

    // Activation selects speaker by default. Reassert the user's current
    // choice and verify the route before starting either media direction.
    const selected = await applyVoiceRoute(voiceRoute);
    if (Platform.OS === "android" && selected !== voiceRoute) {
      throw new Error(`Could not select ${voiceRoute} for communication audio`);
    }

    await getAudioContext().resume();

    // A focus-loss callback can land while the audio graph is coming up. Check
    // once more after resume so no capture or playback starts in that window.
    if (
      Platform.OS === "android" &&
      !(await AudioManager.getAudioFocusState())
    ) {
      throw new Error("Communication audio focus was lost while starting");
    }
  } catch (error) {
    if (audioSessionActivated) {
      await AudioManager.setAudioSessionActivity(false);
    }
    communicationModeActive = false;
    routedDevice = null;
    throw error;
  }
}

export async function deactivateVoiceSession(): Promise<void> {
  if (audioContext && audioContext.state !== "closed") {
    await audioContext.suspend();
  }
  try {
    await AudioManager.setAudioSessionActivity(false);
  } finally {
    communicationModeActive = false;
    routedDevice = null;
  }
}

export function createPlaybackQueue(): AudioBufferQueueSourceNode {
  const context = getAudioContext();
  const queue = context.createBufferQueueSource();
  queue.connect(context.destination);
  return queue;
}

function resample(
  input: Float32Array,
  frames: number,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) {
    return input.subarray(0, frames);
  }

  const ratio = fromRate / toRate;
  const outputFrames = Math.floor(frames / ratio);
  const output = new Float32Array(outputFrames);

  for (let i = 0; i < outputFrames; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, frames - 1);
    const weight = position - index;
    output[i] = input[index] * (1 - weight) + input[next] * weight;
  }

  return output;
}

/**
 * Recorder callbacks deliver float samples at whatever rate the hardware chose,
 * so resample to 24 kHz and pack as little-endian PCM16 for the wire.
 */
export function encodeCaptureChunk(
  samples: Float32Array,
  frames: number,
  inputSampleRate: number,
): string {
  const resampled = resample(
    samples,
    frames,
    inputSampleRate,
    REALTIME_SAMPLE_RATE,
  );
  const pcm = new Uint8Array(resampled.length * 2);

  for (let i = 0; i < resampled.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, resampled[i]));
    const value = Math.round(clamped * 32767);
    pcm[i * 2] = value & 0xff;
    pcm[i * 2 + 1] = (value >> 8) & 0xff;
  }

  return encodeBase64(pcm);
}

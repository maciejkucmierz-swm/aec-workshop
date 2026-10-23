import { Platform } from "react-native";
import {
  AudioContext,
  AudioManager,
  AudioRecorder,
  type AudioBufferQueueSourceNode,
  type AudioDeviceInfo,
} from "react-native-audio-api";
import { encodeBase64, REALTIME_SAMPLE_RATE } from "@/lib/pcm";

export { REALTIME_SAMPLE_RATE } from "@/lib/pcm";

/** ~100 ms of audio per upstream chunk. */
export const CAPTURE_BUFFER_LENGTH = REALTIME_SAMPLE_RATE / 10;

/**
 * Comparison profiles use only upstream constructor options. They are immutable,
 * so changing profiles replaces the stopped recorder and suspended context.
 */
export type AudioStreamProfile =
  | "voice-processing"
  | "upstream-defaults"
  | "media-output";

let activeStreamProfile: AudioStreamProfile = "voice-processing";
let audioContext: AudioContext | null = null;
let recorder: AudioRecorder | null = null;

async function selectAudioStreamProfile(profile: AudioStreamProfile): Promise<void> {
  if (profile === activeStreamProfile) {
    return;
  }

  if (recorder) {
    recorder.clearOnAudioReady();
    recorder.clearOnError();
    if (recorder.isRecording() || recorder.isPaused()) {
      await recorder.stop();
    }
    recorder.disconnect();
    recorder = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    await audioContext.close();
  }
  audioContext = null;
  activeStreamProfile = profile;
}

/** Keep the playback context and incoming Realtime buffers at the same rate. */
export function getAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({
      sampleRate: REALTIME_SAMPLE_RATE,
      androidOutputProfile: activeStreamProfile === "voice-processing"
        ? "voiceCommunication" : "media",
    });
  }
  return audioContext;
}

export function getRecorder(): AudioRecorder {
  if (!recorder) {
    const voiceProcessing = activeStreamProfile !== "upstream-defaults";
    recorder = new AudioRecorder({
      androidInputPreset: voiceProcessing ? "voiceCommunication" : "voiceRecognition",
      iosVoiceProcessing: voiceProcessing,
    });
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
/** The actual communication output last reported by the platform. */
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

function configureSystemOptions(): void {
  AudioManager.setSystemOptions({
    ios: {
      category: "playAndRecord",
      mode: "voiceChat",
      options: voiceRoute === "speaker"
        ? ["allowBluetoothHFP", "defaultToSpeaker"]
        : ["allowBluetoothHFP"],
    },
    android: { mode: "inCommunication", communicationDevice: voiceRoute },
  });
}

function describeOutput(device: AudioDeviceInfo | undefined | null): string | null {
  if (!device) return null;
  switch (device.category) {
    case "Built-in Speaker":
    case "Speaker":
      return "speaker";
    case "Built-in Earpiece":
    case "Receiver":
      return "earpiece";
    default:
      return device.name;
  }
}

/**
 * Moves communication audio between the earpiece and the loudspeaker.
 *
 * Android 12+ must be verified through AudioManager.getCommunicationDevice(),
 * rather than the requested-device state. If the initial request has
 * not settled, clear the failed selection and request it again, then give the
 * platform no more than 30 seconds to confirm the route.
 *
 * @returns The actual output, or null when there is no
 * active communication session to route.
 */
export async function applyVoiceRoute(
  route: AudioRoute,
): Promise<string | null> {
  voiceRoute = route;

  if (!communicationModeActive) {
    return null;
  }

  if (Platform.OS === "ios") {
    // Upstream communication-device methods are Android-only. iOS routing uses
    // AVAudioSession options, and the public device list reports the real output.
    configureSystemOptions();
    await AudioManager.setAudioSessionActivity(true);
    const devices = await AudioManager.getDevicesInfo();
    routedDevice = describeOutput(devices.currentOutputs[0]);
    return routedDevice;
  }

  const wanted = route;
  const startedAt = Date.now();
  let recovered = false;

  await AudioManager.setCommunicationDevice(wanted);

  while (Date.now() - startedAt < ROUTE_SETTLE_TIMEOUT_MS) {
    const selected = await AudioManager.getCommunicationDevice();
    routedDevice = describeOutput(selected);
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
 * Upstream system options configure the communication session; constructor
 * options configure capture processing and output classification. Android
 * communication sessions require API 31+. AEC remains device-dependent.
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
    if (Platform.OS === "android" && Number(Platform.Version) < 31) {
      throw new Error("RNAA communication comparisons require Android 12 (API 31) or later");
    }
    configureSystemOptions();

    const permission = await AudioManager.requestRecordingPermissions();
    if (permission !== "Granted") {
      throw new Error("Microphone permission denied");
    }

    await AudioManager.setAudioSessionActivity(true);
    audioSessionActivated = true;
    communicationModeActive = Platform.OS === "android" || Platform.OS === "ios";

    const selected = await applyVoiceRoute(voiceRoute);
    if (communicationModeActive && selected !== voiceRoute) {
      throw new Error(`Could not select ${voiceRoute} for communication audio`);
    }

    await getAudioContext().resume();
    if (Platform.OS === "ios") {
      // Enabling Voice Processing I/O can change the engine's output route.
      await applyVoiceRoute(voiceRoute);
    }

    // Focus changes are handled through the session's public interruption events.
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

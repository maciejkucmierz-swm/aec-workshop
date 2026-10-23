import { Platform } from "react-native";
import {
  AudioManager,
  type AudioBufferQueueSourceNode,
} from "react-native-audio-api";

import {
  CAPTURE_BUFFER_LENGTH,
  REALTIME_SAMPLE_RATE,
  activateVoiceSession,
  applyVoiceRoute,
  createPlaybackQueue,
  deactivateVoiceSession,
  encodeCaptureChunk,
  getAudioContext,
  getRecorder,
  getVoiceRoute,
  type AudioStreamProfile,
} from "@/lib/audio-engine";
import { serializeAudioLifecycle } from "@/lib/audio-lifecycle";
import {
  LevelTimeline,
  PlaybackWindow,
  levelRatioDb,
  measureLevels,
  wordOverlapRatio,
} from "@/lib/audio-metrics";
import { fetchEphemeralKey } from "@/lib/token-url";
import realtimeConfig from "../../shared/realtime-config.json";

const MODEL = realtimeConfig.model;
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
const RECENT_EVENT_LIMIT = 5;
const DIAGNOSTICS_INTERVAL_MS = 250;

export type SessionStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";

type RemovableSubscription = { remove: () => void };

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Conversation position, since transcripts do not arrive in order. */
  order: number;
};

export type SessionDiagnostics = {
  micChunks: number;
  micBytes: number;
  audioDeltas: number;
  buffersQueued: number;
  buffersEnded: number;
  contextState: string;
  playbackState: "idle" | "decoding" | "playing" | "drained" | "cleared" | "error";
  lastBufferInfo: string | null;
  recentEvents: string[];
  closeInfo: string | null;
  captureInfo: string | null;
  /** Echo investigation: loudest mic RMS while the speaker was silent. */
  micBaseline: number;
  /** Loudest mic RMS while the speaker was audible and the user silent. */
  echoLevel: number;
  /** How far the leaked audio sits above the room floor, in dB. */
  echoLeakDb: number | null;
  micRms: number;
  playbackAudible: boolean;
  speechTriggers: number;
  triggersWhileSpeaking: number;
  confirmedEchoes: number;
  lastIncident: string | null;
};

function log(message: string): void {
  console.log(`[voice] ${message}`);
}

function describeContext(): string {
  const context = getAudioContext();
  return `${context.state} @ ${context.sampleRate} Hz`;
}

/**
 * Teardown must never strand the UI, so a hanging native call is logged and
 * skipped rather than awaited forever.
 */
async function settle<T>(
  promise: Promise<T>,
  label: string
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out after 3s")), 3000);
      }),
    ]);
    log(`${label} ok`);
    return value;
  } catch (error) {
    log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

type SessionHandlers = {
  onStatus: (status: SessionStatus, detail?: string) => void;
  onMicState: (capturing: boolean) => void;
  onTranscript: (entry: TranscriptEntry) => void;
  onSpeechActivity: (speaking: boolean) => void;
  onDiagnostics: (diagnostics: SessionDiagnostics) => void;
  onWarning: (message: string) => void;
  /** Selects the native stream profile before audio hardware is opened. */
  audioStreamProfile?: AudioStreamProfile;
};

type ServerEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  item_id?: string;
  item?: { id?: string };
  error?: { message?: string; code?: string };
  response?: {
    status?: string;
    status_details?: { error?: { message?: string }; reason?: string };
  };
};

// The model is fixed by the connect URL, so it is intentionally absent here.
const SESSION_UPDATE = {
  type: "session.update",
  session: realtimeConfig.session,
};

function emptyDiagnostics(): SessionDiagnostics {
  return {
    micChunks: 0,
    micBytes: 0,
    audioDeltas: 0,
    buffersQueued: 0,
    buffersEnded: 0,
    contextState: "unknown",
    playbackState: "idle",
    lastBufferInfo: null,
    recentEvents: [],
    closeInfo: null,
    captureInfo: null,
    micBaseline: 0,
    echoLevel: 0,
    echoLeakDb: null,
    micRms: 0,
    playbackAudible: false,
    speechTriggers: 0,
    triggersWhileSpeaking: 0,
    confirmedEchoes: 0,
    lastIncident: null,
  };
}

export class RealtimeSession {
  private socket: WebSocket | null = null;
  private queue: AudioBufferQueueSourceNode | null = null;
  /** The queue source is started once per session and left running. */
  private queueStarted = false;
  /** Buffers enqueued but not yet finished, i.e. current queue depth. */
  private pendingBuffers = 0;
  private decodeChain: Promise<void> = Promise.resolve();
  /** Invalidates PCM which was already decoding when playback is cleared. */
  private playbackGeneration = 0;
  /** Prevents callbacks from an older socket changing a newer session. */
  private connectionGeneration = 0;
  private active = false;
  private waitingForSessionUpdate = false;
  /** This session is responsible for releasing the shared native audio session. */
  private ownsAudioSession = false;
  /** No voice media may run while another app owns Android audio focus. */
  private audioFocusPaused = false;
  private resumeMicAfterFocusGain = false;
  private audioFocusSubscriptions: RemovableSubscription[] = [];
  /** Latest requested mic state; stale native starts cannot override a newer choice. */
  private micGeneration = 0;
  /** Mic capture is independent of the socket, so typing cannot be interrupted. */
  private capturing = false;
  private playbackErrorReported = false;
  private rateMismatchReported = false;
  private diagnostics = emptyDiagnostics();
  private lastDiagnosticsAt = 0;
  private eventWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Accumulates streamed transcript deltas per conversation item. */
  private transcripts = new Map<string, string>();
  /** Conversation position per item, assigned when the item first appears. */
  private itemOrder = new Map<string, number>();
  private orderCounter = 0;
  private readonly playbackWindow = new PlaybackWindow();
  private readonly timeline = new LevelTimeline();
  /** Server VAD's current view of the input, recorded alongside mic levels. */
  private userSpeechActive = false;
  /** Recent assistant words, used to recognise our own audio coming back. */
  private assistantHistory: string[] = [];
  private lastAssistantItemId: string | null = null;

  constructor(private readonly handlers: SessionHandlers) {}

  /** Prepares native audio and the socket without starting microphone capture. */
  async connect({ waitForSessionReady = false }: { waitForSessionReady?: boolean } = {}): Promise<void> {
    if (this.active) {
      return;
    }

    const connectionGeneration = ++this.connectionGeneration;
    this.active = true;
    this.waitingForSessionUpdate = waitForSessionReady;
    this.handlers.onStatus("connecting");

    let ephemeralKey: string;
    try {
      log("fetching ephemeral key");
      ephemeralKey = await fetchEphemeralKey();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error), connectionGeneration);
      return;
    }

    if (!this.isCurrentConnection(connectionGeneration)) {
      return;
    }

    await serializeAudioLifecycle(async () => {
      if (!this.isCurrentConnection(connectionGeneration)) {
        return;
      }

      this.audioFocusPaused = false;
      this.resumeMicAfterFocusGain = false;
      this.playbackErrorReported = false;
      this.rateMismatchReported = false;
      this.pendingBuffers = 0;
      this.playbackWindow.reset();
      this.timeline.clear();
      this.userSpeechActive = false;
      this.assistantHistory = [];
      this.lastAssistantItemId = null;
      this.diagnostics = emptyDiagnostics();
      this.transcripts.clear();
      this.itemOrder.clear();
      this.orderCounter = 0;
      this.emitDiagnostics(true);

      try {
        await this.prepareAudioOwned(connectionGeneration);
        if (!this.isCurrentConnection(connectionGeneration)) {
          return;
        }
        // React Native cannot set headers on a WebSocket handshake, so the
        // ephemeral key travels as a subprotocol like it does in browsers.
        const socket = new WebSocket(REALTIME_URL, [
          "realtime",
          `openai-insecure-api-key.${ephemeralKey}`,
        ]);
        this.socket = socket;

        socket.onopen = () => {
          if (!this.isCurrentSocket(socket, connectionGeneration)) {
            return;
          }
          log("websocket open");
          if (!waitForSessionReady) this.handlers.onStatus("connected");
          // Assert the config here too, rather than trusting the minted session.
          this.send(SESSION_UPDATE);

          this.eventWatchdog = setTimeout(() => {
            if (this.diagnostics.recentEvents.length === 0) {
              this.handlers.onWarning(
                "Connected but no server events in 10s - session.update may have been rejected"
              );
            }
          }, 10000);
        };

        socket.onmessage = (event) => {
          if (!this.isCurrentSocket(socket, connectionGeneration)) {
            return;
          }
          this.handleServerEvent(event.data);
        };

        socket.onerror = () => {
          this.fail("WebSocket error. Is the device online?", connectionGeneration);
        };

        socket.onclose = (event) => {
          if (!this.isCurrentSocket(socket, connectionGeneration)) {
            return;
          }
          this.diagnostics.closeInfo = `code ${event.code}${
            event.reason ? ` - ${event.reason}` : ""
          }`;
          this.emitDiagnostics(true);
          this.fail(event.reason || `Connection closed (code ${event.code})`, connectionGeneration);
        };
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error), connectionGeneration);
      }
    });
  }

  /** Called inside the lifecycle queue before the connection becomes ready. */
  private async prepareAudioOwned(generation: number): Promise<void> {
    if (this.ownsAudioSession || !this.isCurrentConnection(generation)) return;
    this.ownsAudioSession = true;
    this.subscribeAudioFocus();
    if (Platform.OS === "ios") AudioManager.observeAudioInterruptions(true);
    await activateVoiceSession(this.handlers.audioStreamProfile);
    if (!this.isCurrentConnection(generation)) return;
    getRecorder();
    this.diagnostics.contextState = describeContext();
    const queue = createPlaybackQueue();
    this.queue = queue;
    queue.onbufferended = (event) => {
      if (this.queue !== queue || !this.isCurrentConnection(generation)) return;
      this.diagnostics.buffersEnded += 1;
      this.pendingBuffers = Math.max(0, this.pendingBuffers - 1);
      if (event.isLastBufferInQueue && this.pendingBuffers === 0) {
        this.diagnostics.playbackState = "drained";
      }
      this.emitDiagnostics(true);
    };
  }

  async disconnect(): Promise<void> {
    if (!this.active) {
      return;
    }
    log("disconnect requested");
    this.active = false;
    const connectionGeneration = ++this.connectionGeneration;
    this.micGeneration += 1;
    this.capturing = false;
    this.invalidatePlayback();
    // Keep the button disabled until native teardown releases shared audio.
    this.handlers.onSpeechActivity(false);
    this.handlers.onMicState(false);
    this.handlers.onStatus("disconnecting");
    await serializeAudioLifecycle(() => this.teardown());
    if (this.connectionGeneration === connectionGeneration && !this.active) {
      this.handlers.onStatus("idle");
    }
  }

  private isCurrentConnection(connectionGeneration: number): boolean {
    return this.active && this.connectionGeneration === connectionGeneration;
  }

  private isCurrentSocket(socket: WebSocket, connectionGeneration: number): boolean {
    return this.socket === socket && this.isCurrentConnection(connectionGeneration);
  }

  private async teardown(): Promise<void> {
    log("teardown start");

    if (this.eventWatchdog) {
      clearTimeout(this.eventWatchdog);
      this.eventWatchdog = null;
    }

    this.audioFocusSubscriptions.forEach((subscription) => subscription.remove());
    this.audioFocusSubscriptions = [];
    this.audioFocusPaused = false;
    this.resumeMicAfterFocusGain = false;

    try {
      this.socket?.close();
    } catch (error) {
      log(`socket close failed: ${String(error)}`);
    }
    this.socket = null;

    if (this.ownsAudioSession) {
      if (Platform.OS === "ios") {
        AudioManager.observeAudioInterruptions(false);
      }
      this.capturing = false;
      await this.stopRecorder();
      this.stopPlayback();
      this.ownsAudioSession = false;
      await settle(deactivateVoiceSession(), "deactivateVoiceSession");
    }
    this.transcripts.clear();
    this.itemOrder.clear();

    log("teardown complete");
  }

  sendText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const delivered =
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: trimmed }],
        },
      }) && this.send({ type: "response.create" });

    if (!delivered) {
      this.handlers.onWarning("Message not sent: socket is not open");
      return;
    }

    const id = `local-${Date.now()}`;
    this.handlers.onTranscript({
      id,
      role: "user",
      text: trimmed,
      order: this.orderFor(id),
    });
  }

  /** Starts streaming the mic. Requires an open socket; leaves it alone on failure. */
  async startMic(): Promise<void> {
    if (this.capturing || !this.active) {
      return;
    }
    const generation = this.connectionGeneration;
    const micGeneration = ++this.micGeneration;
    try {
      await serializeAudioLifecycle(async () => {
        if (!this.isCurrentConnection(generation) || micGeneration !== this.micGeneration) return;
        await this.prepareAudioOwned(generation);
        await this.startMicOwned(generation, micGeneration);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error), generation);
    }
  }

  /** Called only while holding the shared native lifecycle queue. */
  private async startMicOwned(generation: number, micGeneration: number): Promise<void> {
    if (!this.isCurrentConnection(generation) || micGeneration !== this.micGeneration) {
      return;
    }
    if (this.capturing || !this.active || !this.ownsAudioSession) {
      return;
    }

    if (this.audioFocusPaused) {
      this.handlers.onWarning("Voice is paused while another app has audio focus");
      return;
    }

    if (this.socket?.readyState !== 1) {
      this.handlers.onWarning("Connect before switching to voice");
      return;
    }

    this.capturing = true;
    let firstBuffer = true;

    const recorder = getRecorder();

    recorder.onError(({ message }) => {
      if (!this.isCurrentConnection(generation)) {
        return;
      }
      // A mic fault no longer kills the session: text mode still works.
      void this.stopMic();
      this.handlers.onWarning(`Recorder error: ${message}`);
    });

    const registration = recorder.onAudioReady(
      {
        sampleRate: REALTIME_SAMPLE_RATE,
        bufferLength: CAPTURE_BUFFER_LENGTH,
        channelCount: 1,
      },
      ({ buffer, numFrames }) => {
        // A callback can still land after the mic is switched off.
        if (!this.isCurrentConnection(generation) || micGeneration !== this.micGeneration ||
          !this.capturing || this.audioFocusPaused || numFrames <= 0) {
          return;
        }
        if (firstBuffer) {
          firstBuffer = false;
          this.handlers.onMicState(true);
        }

        if (this.diagnostics.micChunks === 0) {
          // The device may ignore the requested rate and buffer size.
          this.diagnostics.captureInfo = `${buffer.sampleRate} Hz, ${numFrames} frames`;
          log(`first mic callback: ${this.diagnostics.captureInfo}`);
        }

        const channel = buffer.getChannelData(0);

        // Measure the exact frames being sent upstream, on the same clock as
        // the playback model, so a false trigger can be correlated with it.
        const now = Date.now();
        const levels = measureLevels(channel, numFrames);
        const playbackAudible = this.playbackWindow.audible(now);
        this.timeline.push({
          at: now,
          micRms: levels.rms,
          micPeak: levels.peak,
          playbackRms: this.playbackWindow.levelAt(now),
          playbackAudible,
          vadActive: this.userSpeechActive,
        });
        this.diagnostics.micRms = levels.rms;
        this.diagnostics.playbackAudible = playbackAudible;
        const baseline = this.timeline.quietMicBaseline();
        const echo = this.timeline.echoMicLevel();
        this.diagnostics.micBaseline = baseline;
        this.diagnostics.echoLevel = echo;
        this.diagnostics.echoLeakDb = levelRatioDb(echo, baseline);

        if (this.socket?.readyState !== 1) {
          return;
        }

        const audio = encodeCaptureChunk(channel, numFrames, buffer.sampleRate);

        if (!this.send({ type: "input_audio_buffer.append", audio })) {
          return;
        }

        this.diagnostics.micChunks += 1;
        // base64 carries 3 bytes per 4 characters.
        this.diagnostics.micBytes += Math.floor((audio.length * 3) / 4);
        this.emitDiagnostics();
      }
    );

    if (registration.status === "error") {
      await this.stopMicOwned();
      this.handlers.onWarning(`Could not attach mic callback: ${registration.message}`);
      return;
    }

    log("starting recorder");
    const started = await recorder.start();
    if (!this.isCurrentConnection(generation) || micGeneration !== this.micGeneration) {
      await this.stopMicOwned();
      return;
    }
    if (started.status === "error") {
      await this.stopMicOwned();
      this.handlers.onWarning(`Recorder failed to start: ${started.message}`);
      return;
    }
    log("recorder started");
  }

  /** Stops streaming the mic without touching the socket or playback. */
  async stopMic(): Promise<void> {
    const generation = this.connectionGeneration;
    this.micGeneration += 1;
    this.pauseMicDelivery();
    await serializeAudioLifecycle(async () => {
      if (generation === this.connectionGeneration && this.ownsAudioSession) {
        await this.stopRecorder();
        this.send({ type: "input_audio_buffer.clear" });
      }
    });
  }

  private pauseMicDelivery(): void {
    log("mic off");
    this.capturing = false;
    this.userSpeechActive = false;
    this.handlers.onMicState(false);
    this.handlers.onSpeechActivity(false);
  }

  private async stopMicOwned(): Promise<void> {
    this.pauseMicDelivery();
    await this.stopRecorder();

    // Drop a half-spoken utterance so VAD cannot commit it later.
    this.send({ type: "input_audio_buffer.clear" });
  }

  private async stopRecorder(): Promise<void> {
    const recorder = getRecorder();

    try {
      recorder.clearOnAudioReady();
      recorder.clearOnError();
    } catch (error) {
      log(`clearing recorder callbacks failed: ${String(error)}`);
    }

    if (recorder.isRecording()) {
      await settle(recorder.stop(), "recorder.stop");
    }
  }

  private handleServerEvent(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case "session.created":
      case "session.updated":
        this.recordEvent(event.type);
        if (event.type === "session.updated" && this.waitingForSessionUpdate) {
          this.waitingForSessionUpdate = false;
          this.handlers.onStatus("connected");
        }
        break;

      // Claims a conversation slot before any transcript text exists, which is
      // what keeps a late user transcript above the reply it caused.
      case "conversation.item.added":
      case "conversation.item.created":
        this.recordEvent(event.type);
        if (event.item?.id) {
          this.orderFor(event.item.id);
        }
        break;

      case "input_audio_buffer.committed":
        this.recordEvent(event.type);
        if (event.item_id) {
          this.orderFor(event.item_id);
        }
        break;

      // GA emits response.output_audio.*; older snapshots emit response.audio.*.
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.recordEvent(event.type);
        if (event.delta) {
          this.diagnostics.audioDeltas += 1;
          this.enqueueAudio(event.delta);
        }
        break;

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
      case "response.output_text.delta":
        this.recordEvent(event.type);
        if (event.delta) {
          this.appendTranscript(event.item_id, "assistant", event.delta);
        }
        break;

      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
      case "response.output_text.done":
        this.recordEvent(event.type);
        this.finishTranscript(
          event.item_id,
          "assistant",
          event.transcript ?? event.text
        );
        break;

      case "conversation.item.input_audio_transcription.completed":
        this.recordEvent(event.type);
        if (event.transcript?.trim()) {
          this.finishTranscript(event.item_id, "user", event.transcript);
          this.checkForSelfAudio(event.transcript);
          this.send({ type: "response.create" });
        } else if (event.item_id) {
          // Server VAD can commit a short noise burst as a user item. Do not
          // answer it or leave an invisible item in conversation history.
          this.send({
            type: "conversation.item.delete",
            item_id: event.item_id,
          });
        }
        break;

      case "conversation.item.input_audio_transcription.failed":
        this.recordEvent(event.type);
        if (event.item_id) {
          this.send({
            type: "conversation.item.delete",
            item_id: event.item_id,
          });
        }
        break;

      case "input_audio_buffer.speech_started":
        this.recordEvent(event.type);
        // Must run before barge-in clears the queue, which ends the window.
        this.recordSpeechTrigger();
        this.userSpeechActive = true;
        this.handlers.onSpeechActivity(true);
        // Barge-in: drop assistant audio that has not played yet.
        this.invalidatePlayback();
        break;

      case "input_audio_buffer.speech_stopped":
        this.recordEvent(event.type);
        this.userSpeechActive = false;
        this.handlers.onSpeechActivity(false);
        break;

      case "response.done":
        this.recordEvent(event.type);
        if (event.response?.status === "failed") {
          this.handlers.onWarning(
            event.response.status_details?.error?.message ??
              event.response.status_details?.reason ??
              "Response failed"
          );
        }
        break;

      case "input_audio_buffer.cleared":
      case "rate_limits.updated":
        this.recordEvent(event.type);
        break;

      // Server errors are per-event and leave the session usable, so warn
      // instead of tearing down. Fatal problems close the socket instead.
      case "error":
        this.recordEvent(`error ${event.error?.code ?? ""}`.trim());
        this.handlers.onWarning(event.error?.message ?? "Realtime API error");
        break;

      default:
        // Unhandled types are prefixed so the debug feed makes them obvious.
        this.recordEvent(`? ${event.type}`);
        break;
    }
  }

  /**
   * Correlates a server VAD trigger with whether our own speaker was audible.
   *
   * A trigger that lands while assistant audio is playing is the condition the
   * client reports; the CSV dump is the evidence for it.
   */
  private recordSpeechTrigger(): void {
    const now = Date.now();
    this.diagnostics.speechTriggers += 1;

    const msIntoPlayback = this.playbackWindow.msSinceStart(now);
    if (msIntoPlayback === null) {
      this.diagnostics.lastIncident = "trigger while speaker silent (user speech)";
      this.emitDiagnostics(true);
      return;
    }

    this.diagnostics.triggersWhileSpeaking += 1;

    const micRms = this.timeline.micRmsSince(now - 500);
    const playbackRms = this.playbackWindow.levelAt(now);
    const baseline = this.timeline.quietMicBaseline();
    this.diagnostics.lastIncident =
      `trigger ${msIntoPlayback} ms into assistant audio; mic rms ` +
      `${micRms.toFixed(4)} vs quiet baseline ${baseline.toFixed(4)}, ` +
      `playback rms ${playbackRms.toFixed(4)}`;

    log(`suspected self-audio trigger: ${this.diagnostics.lastIncident}`);
    const csv = this.timeline.toCsv(now - 3000, now);
    if (csv) {
      log(`incident window CSV (3s before trigger)\n${csv}`);
    }

    this.emitDiagnostics(true);
  }

  /**
   * User speech is transcribed asynchronously and can land after the reply it
   * triggered, so position comes from when the item joined the conversation.
   */
  private orderFor(id: string): number {
    const existing = this.itemOrder.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const next = this.orderCounter;
    this.orderCounter += 1;
    this.itemOrder.set(id, next);
    return next;
  }

  /** What the assistant has said recently, including the utterance in flight. */
  private assistantReferenceText(): string {
    const inFlight = this.lastAssistantItemId
      ? this.transcripts.get(this.lastAssistantItemId) ?? ""
      : "";
    return [...this.assistantHistory, inFlight].join(" ");
  }

  /**
   * Flags a "user" transcript that mostly repeats the assistant, which means
   * the microphone picked up our own speaker rather than the user.
   */
  private checkForSelfAudio(transcript: string | undefined): void {
    if (!transcript) {
      return;
    }

    // Single words match too easily to mean anything.
    const words = transcript.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) {
      return;
    }

    const ratio = wordOverlapRatio(transcript, this.assistantReferenceText());
    if (ratio < 0.6) {
      return;
    }

    this.diagnostics.confirmedEchoes += 1;
    this.diagnostics.lastIncident =
      `likely self-audio: "${transcript.trim()}" repeats assistant speech ` +
      `(${Math.round(ratio * 100)}% of words)`;
    log(this.diagnostics.lastIncident);
    this.handlers.onWarning(this.diagnostics.lastIncident);
    this.emitDiagnostics(true);
  }

  private appendTranscript(
    itemId: string | undefined,
    role: TranscriptEntry["role"],
    delta: string
  ): void {
    const id = itemId ?? `${role}-pending`;
    const text = (this.transcripts.get(id) ?? "") + delta;
    this.transcripts.set(id, text);
    if (role === "assistant") {
      this.lastAssistantItemId = id;
    }
    this.handlers.onTranscript({ id, role, text, order: this.orderFor(id) });
  }

  private finishTranscript(
    itemId: string | undefined,
    role: TranscriptEntry["role"],
    text: string | undefined
  ): void {
    const id = itemId ?? `${role}-${Date.now()}`;
    const final = text ?? this.transcripts.get(id);
    if (!final) {
      return;
    }
    this.transcripts.set(id, final);
    if (role === "assistant") {
      this.lastAssistantItemId = id;
      this.assistantHistory = [...this.assistantHistory, final].slice(-3);
    }
    this.handlers.onTranscript({ id, role, text: final, order: this.orderFor(id) });
  }

  private enqueueAudio(base64Pcm: string): void {
    const queue = this.queue;
    const playbackGeneration = this.playbackGeneration;
    if (!queue || this.audioFocusPaused) {
      return;
    }

    // Decoding is async, so chain it to keep chunks in wire order.
    this.decodeChain = this.decodeChain
      .then(async () => {
        if (
          !this.active ||
          this.audioFocusPaused ||
          playbackGeneration !== this.playbackGeneration
        ) {
          return;
        }

        this.diagnostics.playbackState = "decoding";
        const context = getAudioContext();
        if (context.state !== "running") {
          await serializeAudioLifecycle(async () => {
            if (
              this.active && this.ownsAudioSession && !this.audioFocusPaused &&
              this.queue === queue && playbackGeneration === this.playbackGeneration
            ) {
              await context.resume();
            }
          });
        }
        if (
          !this.active || this.audioFocusPaused || this.queue !== queue ||
          playbackGeneration !== this.playbackGeneration
        ) {
          return;
        }
        this.diagnostics.contextState = describeContext();

        const buffer = await context.decodePCMInBase64(
          base64Pcm,
          REALTIME_SAMPLE_RATE,
          1,
          false
        );

        // Teardown can happen while native decoding is in flight.
        if (
          !this.active ||
          this.audioFocusPaused ||
          this.queue !== queue ||
          playbackGeneration !== this.playbackGeneration
        ) {
          return;
        }

        const levels = measureLevels(
          buffer.getChannelData(0),
          buffer.length
        );
        this.diagnostics.lastBufferInfo =
          `${buffer.sampleRate} Hz, ${Math.round(buffer.duration * 1000)} ms, ` +
          `peak ${levels.peak.toFixed(3)}`;
        // Track when this audio will actually be leaving the speaker.
        this.playbackWindow.add(buffer.duration, levels.rms, Date.now());

        // Buffer sources ignore the buffer's own rate, so any mismatch here
        // plays back at the wrong speed and pitch instead of failing loudly.
        if (buffer.sampleRate !== context.sampleRate && !this.rateMismatchReported) {
          this.rateMismatchReported = true;
          this.handlers.onWarning(
            `Buffer is ${buffer.sampleRate} Hz but context is ${context.sampleRate} Hz: playback will be off-pitch`
          );
        }

        queue.enqueueBuffer(buffer);
        this.pendingBuffers += 1;
        if (!this.queueStarted) {
          // The native queue must have its first buffer before start(). Starting
          // an empty queue can leave iOS rendering silence after that buffer.
          this.startQueue(queue);
        }
        this.diagnostics.playbackState = "playing";

        this.diagnostics.buffersQueued += 1;
        this.emitDiagnostics();
      })
      .catch((error: unknown) => {
        // Report once: a broken decoder would otherwise spam every chunk.
        if (this.playbackErrorReported) {
          return;
        }
        this.playbackErrorReported = true;
        this.diagnostics.playbackState = "error";
        this.emitDiagnostics(true);
        this.handlers.onWarning(
          `Playback error: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  private startQueue(queue: AudioBufferQueueSourceNode): void {
    try {
      // Start at the context's current time with no offset into the queued audio.
      queue.start(getAudioContext().currentTime, 0);
      this.queueStarted = true;
    } catch (error) {
      this.diagnostics.playbackState = "error";
      this.handlers.onWarning(
        `Playback start failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * The upstream communication session owns the voice-communication focus request.
   * The app owns media behavior, so focus loss must suspend both the context
   * and microphone instead of letting speech duck or leak.
   */
  private subscribeAudioFocus(): void {
    if (this.audioFocusSubscriptions.length > 0) {
      return;
    }
    const generation = this.connectionGeneration;

    const interruption = AudioManager.addSystemEventListener(
      "interruption",
      (event) => {
        if (!this.isCurrentConnection(generation)) {
          return;
        }
        this.queueFocusTransition(() =>
          event.type === "began"
            ? this.handleAudioFocusPause()
            : this.handleAudioFocusEnd(event.shouldResume)
        );
      }
    );
    const duck = AudioManager.addSystemEventListener("duck", () => {
      if (!this.isCurrentConnection(generation)) {
        return;
      }
      this.queueFocusTransition(() => this.handleAudioFocusPause());
    });
    this.audioFocusSubscriptions = [];
    if (interruption) {
      this.audioFocusSubscriptions.push(interruption);
    }
    if (duck) {
      this.audioFocusSubscriptions.push(duck);
    }
  }

  private queueFocusTransition(operation: () => Promise<void>): void {
    const generation = this.connectionGeneration;
    void serializeAudioLifecycle(async () => {
      if (this.isCurrentConnection(generation) && this.ownsAudioSession) {
        await operation();
      }
    }).catch((error: unknown) => {
      log(
        `audio focus transition failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private async handleAudioFocusEnd(shouldResume: boolean): Promise<void> {
    if (
      !this.active ||
      !this.ownsAudioSession ||
      !this.audioFocusPaused ||
      !shouldResume
    ) {
      return;
    }

    const shouldResumeMic = this.resumeMicAfterFocusGain;
    this.audioFocusPaused = false;
    this.resumeMicAfterFocusGain = false;

    const generation = this.connectionGeneration;
    if (Platform.OS === "ios") {
      await AudioManager.setAudioSessionActivity(true);
      if (!this.isCurrentConnection(generation)) {
        return;
      }
    }
    await getAudioContext().resume();
    if (!this.isCurrentConnection(generation)) {
      return;
    }
    if (Platform.OS === "ios") {
      await applyVoiceRoute(getVoiceRoute());
      if (!this.isCurrentConnection(generation)) {
        return;
      }
    }
    this.diagnostics.contextState = describeContext();
    this.emitDiagnostics(true);
    if (shouldResumeMic) {
      await this.startMicOwned(generation, ++this.micGeneration);
    }
    this.handlers.onWarning("Audio focus returned; voice resumed");
  }

  private async handleAudioFocusPause(): Promise<void> {
    if (!this.active || !this.ownsAudioSession || this.audioFocusPaused) {
      return;
    }

    const generation = this.connectionGeneration;
    const wasCapturing = this.capturing;
    this.micGeneration += 1;
    this.audioFocusPaused = true;
    this.resumeMicAfterFocusGain = wasCapturing;
    this.invalidatePlayback();
    if (wasCapturing) {
      await this.stopMicOwned();
    }
    if (!this.isCurrentConnection(generation)) {
      return;
    }
    await getAudioContext().suspend();
    if (!this.isCurrentConnection(generation)) {
      return;
    }
    this.diagnostics.contextState = describeContext();
    this.emitDiagnostics(true);
    this.handlers.onWarning("Voice paused because audio focus was lost");
  }

  private invalidatePlayback(): void {
    try {
      this.playbackGeneration += 1;
      // clearBuffers drops the queue without firing onbufferended, and rewinds
      // the read index natively, so the pending count resets with it.
      this.pendingBuffers = 0;
      // Dropped audio never reaches the speaker, so the window ends now.
      this.playbackWindow.truncate(Date.now());
      this.queue?.clearBuffers();
      this.diagnostics.playbackState = "cleared";
      this.emitDiagnostics(true);
    } catch {
      // Nothing queued.
    }
  }

  private stopPlayback(): void {
    this.invalidatePlayback();
    if (this.queue) this.queue.onbufferended = null;
    try {
      this.queue?.stop();
      this.queue?.disconnect();
    } catch {
      // Already stopped.
    }
    this.queue = null;
    this.queueStarted = false;
    this.diagnostics.playbackState = "idle";
    this.diagnostics.contextState = describeContext();
  }

  private recordEvent(type: string): void {
    if (this.eventWatchdog) {
      clearTimeout(this.eventWatchdog);
      this.eventWatchdog = null;
    }
    this.diagnostics.recentEvents = [
      type,
      ...this.diagnostics.recentEvents,
    ].slice(0, RECENT_EVENT_LIMIT);
    this.emitDiagnostics();
  }

  private emitDiagnostics(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastDiagnosticsAt < DIAGNOSTICS_INTERVAL_MS) {
      return;
    }
    this.lastDiagnosticsAt = now;
    this.handlers.onDiagnostics({ ...this.diagnostics });
  }

  private send(payload: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== 1) {
      return false;
    }
    this.socket.send(JSON.stringify(payload));
    return true;
  }

  private fail(message: string, expectedGeneration = this.connectionGeneration): void {
    if (!this.isCurrentConnection(expectedGeneration)) {
      return;
    }
    this.active = false;
    const teardownGeneration = ++this.connectionGeneration;
    this.micGeneration += 1;
    this.capturing = false;
    this.invalidatePlayback();
    this.emitDiagnostics(true);
    this.handlers.onSpeechActivity(false);
    this.handlers.onMicState(false);
    this.handlers.onStatus("disconnecting");
    void serializeAudioLifecycle(() => this.teardown()).then(() => {
      if (this.connectionGeneration === teardownGeneration && !this.active) {
        this.handlers.onStatus("error", message);
      }
    });
  }
}

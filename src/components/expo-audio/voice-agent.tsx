import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioStream,
} from "expo-audio";

import { encodeBase64, REALTIME_SAMPLE_RATE } from "@/lib/pcm";
import { serializeAudioLifecycle } from "@/lib/audio-lifecycle";
import { IS_PROMO } from "@/lib/app-mode";
import { usePromoConnection } from "@/lib/use-promo-connection";
import { PromoVoiceScreen } from "@/components/promo-voice-screen";
import { resolveVoiceSocketUrl } from "@/lib/token-url";
import {
  WorkshopHeading,
  useWorkshopColors,
  useWorkshopStyles,
} from "@/lib/workshop-ui";

type RelayPhase = "idle" | "connecting" | "ready" | "listening" | "assistant" | "error";
type TranscriptEntry = { id: string; role: "user" | "assistant"; text: string };
type DuplexMode = "half-duplex" | "full-duplex";
type Diagnostics = {
  sentDuringPlayback: number;
  receivedMicBuffers: number | null;
  interruptions: number;
};

const EMPTY_DIAGNOSTICS: Diagnostics = {
  sentDuringPlayback: 0,
  receivedMicBuffers: null,
  interruptions: 0,
};

const SPEAKER_MODE = {
  playsInSilentMode: true,
  interruptionMode: "doNotMix",
  shouldRouteThroughEarpiece: false,
} as const;

function resampleToRealtime(data: ArrayBuffer, inputRate: number): Uint8Array {
  const input = new Int16Array(data);
  if (inputRate === REALTIME_SAMPLE_RATE) {
    return new Uint8Array(data);
  }

  const outputFrames = Math.max(
    1,
    Math.round((input.length * REALTIME_SAMPLE_RATE) / inputRate),
  );
  const output = new Uint8Array(outputFrames * 2);
  const ratio = inputRate / REALTIME_SAMPLE_RATE;
  for (let index = 0; index < outputFrames; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const blend = position - left;
    const sample = Math.round(input[left] * (1 - blend) + input[right] * blend);
    output[index * 2] = sample & 0xff;
    output[index * 2 + 1] = (sample >> 8) & 0xff;
  }
  return output;
}

export function ExpoVoiceAgent({ mode }: { mode: DuplexMode }) {
  const colors = useWorkshopColors();
  const workshopStyles = useWorkshopStyles();
  const socketRef = useRef<WebSocket | null>(null);
  const connectingRef = useRef(false);
  const connectionEpochRef = useRef(0);
  const relayReadyRef = useRef(false);
  const micEnabledRef = useRef(false);
  const audioSessionOwnedRef = useRef(false);
  // Includes an in-flight start, so queued teardown also cleans up partial setup.
  const micStartedRef = useRef(false);
  const lastMicBufferAtRef = useRef<number | null>(null);
  const firstMicFrameRef = useRef(true);
  const diagnosticsRef = useRef({ ...EMPTY_DIAGNOSTICS });
  const playbackRef = useRef<{
    id: string;
    legacy: boolean;
    connectionEpoch: number;
    observedPlaying: boolean;
    started: boolean;
  } | null>(null);
  const playingRef = useRef(false);
  const [phase, setPhase] = useState<RelayPhase>("idle");
  const [captureReady, setCaptureReady] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [captureInfo, setCaptureInfo] = useState("--");
  const [diagnostics, setDiagnostics] = useState(EMPTY_DIAGNOSTICS);

  const player = useAudioPlayer(null, {
    downloadFirst: false,
    updateInterval: 100,
    // Pausing/finishing must not schedule Expo's delayed iOS deactivation:
    // it would stop our mic or deactivate the next tab after a blur.
    keepAudioSessionActive: Platform.OS === "ios",
  });
  const playerStatus = useAudioPlayerStatus(player);

  const send = useCallback((message: unknown) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return false;
    }
    socketRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const metric = useCallback(
    (name: string, id?: string) => {
      const at = Date.now();
      console.info(`[Expo ${mode}] ${name} turn=${id ?? "--"} at=${at}`);
      send({ type: "metric", name: `${mode}-${name}`, id, at });
    },
    [mode, send],
  );

  const { stream, isStreaming } = useAudioStream({
    sampleRate: REALTIME_SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: ({ data, sampleRate, channels }) => {
      if (!relayReadyRef.current || !micEnabledRef.current || channels !== 1 || data.byteLength === 0) {
        return;
      }
      lastMicBufferAtRef.current = Date.now();
      const pcm = resampleToRealtime(data, sampleRate);
      if (firstMicFrameRef.current) {
        firstMicFrameRef.current = false;
        setCaptureReady(true);
        setCaptureInfo(
          `mono Int16 · ${sampleRate} Hz → ${REALTIME_SAMPLE_RATE} Hz`,
        );
        metric("first-mic-frame");
      }
      if (send({ type: "audio", data: encodeBase64(pcm) }) && playingRef.current) {
        diagnosticsRef.current.sentDuringPlayback += 1;
      }
    },
  });

  const upsertTranscript = useCallback(
    (
      role: TranscriptEntry["role"],
      id: string | undefined,
      text: string,
      append: boolean,
    ) => {
      const entryId = id ?? `${role}-${Date.now()}`;
      setEntries((current) => {
        const index = current.findIndex((entry) => entry.id === entryId);
        if (index === -1) {
          return [...current, { id: entryId, role, text }];
        }
        const next = [...current];
        next[index] = {
          ...next[index],
          text: append ? next[index].text + text : text,
        };
        return next;
      });
    },
    [],
  );

  const stopMic = useCallback(() => {
    micEnabledRef.current = false;
    setCaptureReady(false);
    setUserSpeaking(false);
    lastMicBufferAtRef.current = null;
    return serializeAudioLifecycle(() => {
      if (!micStartedRef.current) {
        return;
      }
      try {
        stream.stop();
      } finally {
        micStartedRef.current = false;
      }
    }).catch((error) => {
      // Expo Audio may already have released the stream.
      console.warn(`Expo microphone cleanup failed: ${String(error)}`);
    });
  }, [stream]);

  const stopPlayback = useCallback(() => {
    playbackRef.current = null;
    playingRef.current = false;
    try {
      player.pause();
    } catch {
      // The player can already have been released while a tab is changing.
    }
  }, [player]);

  const endConnection = useCallback(
    (nextPhase?: RelayPhase, nextDetail?: string) => {
      connectionEpochRef.current += 1;
      connectingRef.current = false;
      relayReadyRef.current = false;
      const socket = socketRef.current;
      socketRef.current = null;
      stopPlayback();
      void stopMic();
      void serializeAudioLifecycle(async () => {
        if (!audioSessionOwnedRef.current) {
          return;
        }
        audioSessionOwnedRef.current = false;
        if (Platform.OS === "ios") {
          await setIsAudioActiveAsync(false);
        }
      }).catch((error) => {
        console.warn(`Expo audio session cleanup failed: ${String(error)}`);
      });
      socket?.close();
      if (nextDetail !== undefined) {
        setDetail(nextDetail);
      }
      if (nextPhase) {
        setPhase(nextPhase);
      }
    },
    [stopMic, stopPlayback],
  );

  const startMic = useCallback(() => {
    if (!relayReadyRef.current || micEnabledRef.current) {
      return;
    }
    const connectionEpoch = connectionEpochRef.current;
    micEnabledRef.current = true;
    firstMicFrameRef.current = true;
    const isCurrentCapture = () =>
      connectionEpoch === connectionEpochRef.current &&
      relayReadyRef.current &&
      micEnabledRef.current &&
      (mode === "full-duplex" || playbackRef.current === null);
    return serializeAudioLifecycle(async () => {
      if (!isCurrentCapture()) {
        return;
      }
      if (!IS_PROMO || !audioSessionOwnedRef.current) {
        audioSessionOwnedRef.current = true;
        await setAudioModeAsync({ ...SPEAKER_MODE, allowsRecording: true });
      }
      if (!isCurrentCapture()) {
        return;
      }
      micStartedRef.current = true;
      await stream.start();
      if (!isCurrentCapture()) {
        stream.stop();
        micStartedRef.current = false;
        return;
      }
      lastMicBufferAtRef.current = Date.now();
      if (Platform.OS === "ios" && mode === "full-duplex") {
        // SDK 57's iOS stream starts in .record/.measurement. Restore the
        // public play-and-record speaker configuration without stopping it.
        await setAudioModeAsync({ ...SPEAKER_MODE, allowsRecording: true });
        if (!isCurrentCapture()) {
          return;
        }
      }
      setPhase(playbackRef.current ? "assistant" : "listening");
      metric("mic-resumed");
    }).catch((error) => {
      if (connectionEpoch === connectionEpochRef.current) {
        endConnection("error", `Could not start Expo Audio stream: ${String(error)}`);
      }
    });
  }, [endConnection, metric, mode, stream]);

  const stopTurn = useCallback(
    (reason: unknown) => {
      const playback = playbackRef.current;
      if (!playback) {
        return;
      }
      if (reason === "barge-in") {
        diagnosticsRef.current.interruptions += 1;
        metric("playback-interrupted", playback.id);
      }
      stopPlayback();
      if (reason !== "replaced") {
        if (mode === "half-duplex") {
          void startMic();
        } else {
          setPhase("listening");
        }
      }
    },
    [metric, mode, startMic, stopPlayback],
  );

  const openConnection = useCallback(async () => {
    if (connectingRef.current || socketRef.current) return;
    endConnection();
    connectingRef.current = true;
    const connectionEpoch = ++connectionEpochRef.current;
    setPhase("connecting");
    setDetail(null);
    if (!IS_PROMO) setEntries([]);
    setCaptureInfo("--");
    diagnosticsRef.current = { ...EMPTY_DIAGNOSTICS };
    setDiagnostics({ ...EMPTY_DIAGNOSTICS });
    firstMicFrameRef.current = true;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (connectionEpoch !== connectionEpochRef.current) return;
      if (!permission.granted) throw new Error("Microphone permission was denied");
      if (IS_PROMO) {
        await serializeAudioLifecycle(async () => {
          if (connectionEpoch !== connectionEpochRef.current) return;
          audioSessionOwnedRef.current = true;
          await setAudioModeAsync({ ...SPEAKER_MODE, allowsRecording: true });
          if (connectionEpoch !== connectionEpochRef.current) return;
          if (Platform.OS === "ios") await setIsAudioActiveAsync(true);
        });
        if (connectionEpoch !== connectionEpochRef.current) return;
      }
      const socket = new WebSocket(resolveVoiceSocketUrl());
      if (connectionEpoch !== connectionEpochRef.current) {
        socket.close();
        return;
      }
      socketRef.current = socket;
      const isCurrentSocket = () =>
        connectionEpoch === connectionEpochRef.current && socketRef.current === socket;
      socket.onerror = () => {
        if (!isCurrentSocket()) {
          return;
        }
        endConnection(
          "error",
          "Relay WebSocket error. Check the local token server and LAN address.",
        );
      };
      socket.onclose = () => {
        if (!isCurrentSocket()) {
          return;
        }
        endConnection(IS_PROMO ? "error" : "idle", IS_PROMO ? "Relay disconnected" : undefined);
      };
      socket.onmessage = (message) => {
        if (!isCurrentSocket()) {
          return;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(message.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === "relay.ready") {
          connectingRef.current = false;
          relayReadyRef.current = true;
          if (IS_PROMO) setPhase("ready");
          else void startMic();
          return;
        }
        if (event.type === "relay.stats" && typeof event.receivedMicBuffers === "number") {
          diagnosticsRef.current.receivedMicBuffers = event.receivedMicBuffers;
          return;
        }
        if (event.type === "transcript" && typeof event.delta === "string") {
          upsertTranscript(
            event.role === "user" ? "user" : "assistant",
            typeof event.id === "string" ? event.id : undefined,
            event.delta,
            true,
          );
          return;
        }
        if (event.type === "transcript.done" && typeof event.text === "string") {
          upsertTranscript(
            event.role === "user" ? "user" : "assistant",
            typeof event.id === "string" ? event.id : undefined,
            event.text,
            false,
          );
          return;
        }
        if (event.type === "audio.start" && typeof event.url === "string") {
          // Older relay messages omit the ID, but their opaque URL already
          // uniquely identifies the turn. Do not discard playable audio.
          const legacy = typeof event.id !== "string";
          const id = typeof event.id === "string" ? event.id : event.url;
          if (mode === "half-duplex") {
            void stopMic();
            metric("mic-paused", id);
          }
          stopPlayback();
          const playback = {
            id,
            legacy,
            connectionEpoch,
            observedPlaying: false,
            started: false,
          };
          playbackRef.current = playback;
          setPhase("assistant");
          const url = event.url;
          const isCurrentTurn = () => isCurrentSocket() &&
            relayReadyRef.current && playbackRef.current === playback;
          // Half-duplex stop is already queued. Wait for native cleanup before
          // switching iOS to playback-only; never queue the HTTP stream itself.
          void serializeAudioLifecycle(async () => {
            if (!isCurrentTurn()) {
              return;
            }
            if (Platform.OS === "ios" && mode === "half-duplex") {
              await setAudioModeAsync({ ...SPEAKER_MODE, allowsRecording: false });
              if (!isCurrentTurn()) {
                return;
              }
            }
            metric("playback-replaced", id);
            player.replace({ uri: url });
            playback.started = true;
            player.play();
          }).catch((error) => {
            if (isCurrentTurn()) {
              endConnection("error", `Could not play assistant audio: ${String(error)}`);
            }
          });
          return;
        }
        if (
          event.type === "audio.stop" &&
          playbackRef.current &&
          (event.id === playbackRef.current.id ||
            (event.id === undefined && playbackRef.current.legacy))
        ) {
          stopTurn(event.reason);
          return;
        }
        if (event.type === "speech") {
          setUserSpeaking(event.active === true && micEnabledRef.current);
          if (event.active === true && playbackRef.current?.legacy) {
            // Older relays stop tracking playback when encoding ends. Their VAD
            // event still lets us interrupt audio buffered on the phone.
            stopTurn("barge-in");
          }
          return;
        }
        if (event.type === "error" || event.type === "relay.closed") {
          endConnection(
            "error",
            String(event.message ?? event.reason ?? "Relay disconnected"),
          );
        }
      };
    } catch (error) {
      if (connectionEpoch === connectionEpochRef.current) {
        endConnection(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }, [
    endConnection,
    metric,
    mode,
    player,
    startMic,
    stopMic,
    stopPlayback,
    stopTurn,
    upsertTranscript,
  ]);

  const connectionStatus = phase === "ready" || phase === "listening" || phase === "assistant"
    ? "connected" : phase;
  const { connection: promoConnection, requested: promoRequested, toggle: togglePromo } = usePromoConnection({
    status: connectionStatus,
    microphoneActive: captureReady && isStreaming,
    connect: openConnection,
    disconnect: () => endConnection("idle"),
    startMic,
  });
  const connect = useCallback(() => {
    if (IS_PROMO) {
      if (!promoRequested || phase === "error") setEntries([]);
      togglePromo();
    } else if (phase === "connecting" || phase === "listening" || phase === "assistant") {
      endConnection("idle");
    } else {
      void openConnection();
    }
  }, [endConnection, openConnection, phase, promoRequested, togglePromo]);

  useEffect(() => {
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      const playback = playbackRef.current;
      if (
        !playback ||
        !playback.started ||
        playback.connectionEpoch !== connectionEpochRef.current ||
        !relayReadyRef.current
      ) {
        return;
      }
      // Events can be queued from the preceding source. Check the live public
      // player properties before treating one as playback or completion.
      const playing = player.playing;
      const buffering = player.isBuffering;
      playingRef.current = playing && !buffering;
      if (playingRef.current && !playback.observedPlaying) {
        playback.observedPlaying = true;
        metric("playback-observed-start", playback.id);
      }

      const finished = status.didJustFinish && !playing && !buffering &&
        (playback.observedPlaying || player.currentTime > 0);
      const failed = status.error && !playing && !buffering && !player.isLoaded;
      if (failed || finished) {
        if (failed) {
          setDetail(`Player error: ${status.error}`);
        }
        metric(failed ? "playback-error" : "playback-finished", playback.id);
        stopPlayback();
        if (mode === "half-duplex") {
          void startMic();
        } else {
          setPhase("listening");
        }
      }
    });
    return () => subscription.remove();
  }, [metric, mode, player, startMic, stopPlayback]);

  // Native tabs retain the presentation, just like the RNAA tabs. Blur ends
  // the call without unmounting the UI or recreating native objects on return.
  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => {
        setDiagnostics({ ...diagnosticsRef.current });
        if (
          relayReadyRef.current && micEnabledRef.current &&
          lastMicBufferAtRef.current !== null &&
          Date.now() - lastMicBufferAtRef.current >= 3_000
        ) {
          endConnection(
            "error",
            "Expo Audio capture failed: no microphone buffers for 3 seconds while capture was expected. Session reconfiguration may have stopped capture; no half-duplex fallback was applied.",
          );
        }
      }, 1_000);
      return () => {
        clearInterval(timer);
        if (!IS_PROMO) endConnection("idle");
      };
    }, [endConnection]),
  );

  const sendText = useCallback(() => {
    const text = draft.trim();
    if (phase === "listening" && text && send({ type: "text", text })) {
      setDraft("");
    }
  }, [draft, phase, send]);

  let statusLabel: string;
  if (phase === "assistant") {
    statusLabel = mode === "half-duplex"
      ? "Assistant speaking — microphone paused"
      : "Assistant reply — microphone streaming";
  } else if (phase === "listening") {
    statusLabel = isStreaming ? "Listening — microphone streaming" : "Starting microphone";
  } else {
    statusLabel = phase[0].toUpperCase() + phase.slice(1);
  }

  let assistantStatus = "stopped";
  if (phase === "assistant") {
    if (playerStatus.isBuffering) {
      assistantStatus = "buffering";
    } else {
      assistantStatus = playerStatus.playing ? "playing" : "loading";
    }
  }

  const canSend = phase === "listening" && Boolean(draft.trim());
  const canDisconnect = phase !== "idle" && phase !== "error";
  const assistantPlaying = phase === "assistant" &&
    playerStatus.playing && !playerStatus.isBuffering;

  if (IS_PROMO) {
    return (
      <PromoVoiceScreen
        connection={promoConnection}
        microphoneActive={promoRequested && captureReady && isStreaming}
        userSpeaking={userSpeaking}
        assistantPlaying={assistantPlaying}
        entries={entries}
        error={detail}
        onToggleConnection={() => void connect()}
      />
    );
  }

  return (
    <>
      <WorkshopHeading
        title={
          mode === "half-duplex" ? "Expo Audio half duplex" : "Stock Expo Audio full duplex"
        }
        description={
          mode === "half-duplex"
            ? "Speakerphone fallback: capture pauses for every assistant reply. No barge-in."
            : "Experimental Android/iPhone loudspeaker chat. Capture stays on during replies; simultaneous audio and echo behavior require device validation."
        }
      />
      <View style={workshopStyles.statusRow}>
        <View
          style={[workshopStyles.statusDot, {
            backgroundColor: colors.status[phase === "ready" || phase === "listening" ? "connected" : phase],
          }]}
        />
        <Text style={[workshopStyles.statusText, { color: colors.text }]}>
          {statusLabel}
        </Text>
      </View>
      {detail ? <Text style={workshopStyles.warningText}>{detail}</Text> : null}
      <ScrollView
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
      >
        {entries.length === 0 ? (
          <Text style={[workshopStyles.placeholder, { color: colors.muted }]}>
            Connect, then speak a turn.
          </Text>
        ) : (
          entries.map((entry) => (
            <View key={entry.id} style={styles.entry}>
              <Text style={[workshopStyles.entryRole, { color: colors.muted }]}>
                {entry.role === "user" ? "You" : "Assistant"}
              </Text>
              <Text style={[workshopStyles.entryText, { color: colors.text }]}>
                {entry.text}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
      <View style={workshopStyles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={sendText}
          editable={phase === "listening"}
          placeholder="Type a message"
          placeholderTextColor={colors.placeholder}
          style={[
            workshopStyles.input,
            { color: colors.text, borderColor: colors.border, backgroundColor: colors.field },
          ]}
        />
        <Pressable
          style={[
            workshopStyles.sendButton,
            !canSend && workshopStyles.buttonDisabled,
          ]}
          onPress={sendText}
          disabled={!canSend}
        >
          <Text style={workshopStyles.sendLabel}>Send</Text>
        </Pressable>
      </View>
      <View style={[styles.diagnostics, { backgroundColor: colors.panel }]}>
        <Text style={[workshopStyles.diagnosticText, { color: colors.muted }]}>
          Relay: {resolveVoiceSocketUrl()}
        </Text>
        <Text style={[workshopStyles.diagnosticText, { color: colors.muted }]}>
          speaker route · capture: {captureInfo}
        </Text>
        <Text style={[workshopStyles.diagnosticText, { color: colors.muted }]}>
          Mic: {isStreaming ? "streaming" : "stopped"} · Assistant: {assistantStatus}
        </Text>
        <Text style={[workshopStyles.diagnosticText, { color: colors.muted }]}>
          Buffers sent during playback: {diagnostics.sentDuringPlayback}
          {" · Relay received: "}{diagnostics.receivedMicBuffers ?? "--"}
        </Text>
        <Text style={[workshopStyles.diagnosticText, { color: colors.muted }]}>
          Interruptions: {diagnostics.interruptions} · Player timing is approximate, not acoustic output.
        </Text>
      </View>
      <Pressable
        style={[
          workshopStyles.callButton,
          canDisconnect && workshopStyles.callButtonStop,
        ]}
        onPress={() => void connect()}
      >
        <Text style={[workshopStyles.callLabel, canDisconnect && workshopStyles.callLabelStop]}>
          {canDisconnect ? "Disconnect" : "Connect"}
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  transcript: { flex: 1 },
  transcriptContent: { gap: 12, paddingVertical: 8 },
  entry: { gap: 2 },
  diagnostics: { borderRadius: 8, gap: 2, padding: 8 },
});

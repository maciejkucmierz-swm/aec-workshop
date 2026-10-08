import { useCallback, useEffect, useRef, useState } from "react";
import {
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
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioStream,
} from "expo-audio";

import { encodeBase64, REALTIME_SAMPLE_RATE } from "@/lib/pcm";
import { resolveVoiceSocketUrl } from "@/lib/token-url";
import {
  WORKSHOP_STATUS_COLOR,
  WorkshopHeading,
  useWorkshopColors,
  workshopStyles,
} from "@/lib/workshop-ui";

type RelayPhase = "idle" | "connecting" | "listening" | "assistant" | "error";
type TranscriptEntry = { id: string; role: "user" | "assistant"; text: string };

const PHASE_COLOR: Record<RelayPhase, string> = {
  idle: WORKSHOP_STATUS_COLOR.idle,
  connecting: WORKSHOP_STATUS_COLOR.connecting,
  listening: WORKSHOP_STATUS_COLOR.connected,
  assistant: WORKSHOP_STATUS_COLOR.connected,
  error: WORKSHOP_STATUS_COLOR.error,
};

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

export function HalfDuplexAgent() {
  const colors = useWorkshopColors();
  const socketRef = useRef<WebSocket | null>(null);
  const connectionEpochRef = useRef(0);
  const relayReadyRef = useRef(false);
  const micEnabledRef = useRef(false);
  const firstMicFrameRef = useRef(true);
  const [phase, setPhase] = useState<RelayPhase>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [captureInfo, setCaptureInfo] = useState("--");

  const player = useAudioPlayer(null, { downloadFirst: false, updateInterval: 100 });
  const playerStatus = useAudioPlayerStatus(player);

  const send = useCallback((message: unknown) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      return false;
    }
    socketRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  const { stream, isStreaming } = useAudioStream({
    sampleRate: REALTIME_SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: ({ data, sampleRate, channels }) => {
      if (!relayReadyRef.current || !micEnabledRef.current || channels !== 1) {
        return;
      }
      const pcm = resampleToRealtime(data, sampleRate);
      if (firstMicFrameRef.current) {
        firstMicFrameRef.current = false;
        setCaptureInfo(
          `${sampleRate} Hz → ${REALTIME_SAMPLE_RATE} Hz, ${pcm.length / 2} frames`,
        );
        send({ type: "metric", name: "half-duplex-first-mic-frame", at: Date.now() });
      }
      send({ type: "audio", data: encodeBase64(pcm) });
    },
  });

  const upsertTranscript = useCallback(
    (role: TranscriptEntry["role"], id: string | undefined, text: string, append: boolean) => {
      const entryId = id ?? `${role}-${Date.now()}`;
      setEntries((current) => {
        const index = current.findIndex((entry) => entry.id === entryId);
        if (index === -1) {
          return [...current, { id: entryId, role, text }];
        }
        const next = [...current];
        next[index] = { ...next[index], text: append ? next[index].text + text : text };
        return next;
      });
    },
    [],
  );

  const stopMic = useCallback(() => {
    micEnabledRef.current = false;
    try {
      stream.stop();
    } catch {
      // Expo Audio may already have released the stream.
    }
  }, [stream]);

  const endConnection = useCallback(
    (nextPhase?: RelayPhase, nextDetail?: string) => {
      connectionEpochRef.current += 1;
      relayReadyRef.current = false;
      const socket = socketRef.current;
      socketRef.current = null;
      stopMic();
      try {
        player.pause();
      } catch {
        // The player can already have been released while a tab is changing.
      }
      socket?.close();
      if (nextDetail !== undefined) {
        setDetail(nextDetail);
      }
      if (nextPhase) {
        setPhase(nextPhase);
      }
    },
    [player, stopMic],
  );

  const startMic = useCallback(async () => {
    if (!relayReadyRef.current || micEnabledRef.current) {
      return;
    }
    const connectionEpoch = connectionEpochRef.current;
    micEnabledRef.current = true;
    firstMicFrameRef.current = true;
    try {
      await stream.start();
      if (
        connectionEpoch !== connectionEpochRef.current ||
        !relayReadyRef.current
      ) {
        stopMic();
        return;
      }
      setPhase("listening");
      send({ type: "metric", name: "half-duplex-mic-resumed", at: Date.now() });
    } catch (error) {
      if (connectionEpoch === connectionEpochRef.current) {
        endConnection("error", `Could not start Expo Audio stream: ${String(error)}`);
      }
    }
  }, [endConnection, send, stopMic, stream]);

  const connect = useCallback(async () => {
    if (phase === "connecting" || phase === "listening" || phase === "assistant") {
      endConnection("idle");
      return;
    }

    endConnection();
    const connectionEpoch = ++connectionEpochRef.current;
    setPhase("connecting");
    setDetail(null);
    setEntries([]);
    firstMicFrameRef.current = true;
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (connectionEpoch !== connectionEpochRef.current) {
        return;
      }
      if (!permission.granted) {
        throw new Error("Microphone permission was denied");
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldRouteThroughEarpiece: false,
      });
      if (connectionEpoch !== connectionEpochRef.current) {
        return;
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
        endConnection("idle");
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
          relayReadyRef.current = true;
          void startMic();
          return;
        }
        if (event.type === "transcript" && typeof event.delta === "string") {
          upsertTranscript(event.role === "user" ? "user" : "assistant", typeof event.id === "string" ? event.id : undefined, event.delta, true);
          return;
        }
        if (event.type === "transcript.done" && typeof event.text === "string") {
          upsertTranscript(event.role === "user" ? "user" : "assistant", typeof event.id === "string" ? event.id : undefined, event.text, false);
          return;
        }
        if (event.type === "audio.start" && typeof event.url === "string") {
          stopMic();
          setPhase("assistant");
          send({ type: "metric", name: "half-duplex-mic-paused", at: Date.now() });
          player.replace({ uri: event.url });
          player.play();
          return;
        }
        if (event.type === "audio.stop") {
          player.pause();
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
  }, [endConnection, phase, player, send, startMic, stopMic, upsertTranscript]);

  useEffect(() => {
    if (phase === "assistant" && playerStatus.didJustFinish && relayReadyRef.current) {
      void startMic();
    }
  }, [phase, playerStatus.didJustFinish, startMic]);

  useEffect(() => {
    if (phase === "assistant" && playerStatus.error && relayReadyRef.current) {
      setDetail(`Player error: ${playerStatus.error}`);
      void startMic();
    }
  }, [phase, playerStatus.error, startMic]);

  useEffect(() => () => endConnection(), [endConnection]);

  const sendText = useCallback(() => {
    const text = draft.trim();
    if (phase === "listening" && text && send({ type: "text", text })) {
      setDraft("");
    }
  }, [draft, phase, send]);

  const statusLabel = phase === "assistant"
    ? "Assistant speaking — microphone paused"
    : phase === "listening"
      ? isStreaming ? "Listening — microphone streaming" : "Starting microphone"
      : phase[0].toUpperCase() + phase.slice(1);

  return (
    <>
      <WorkshopHeading
        title="Expo Audio half duplex"
        description="Speakerphone fallback: capture pauses for every assistant reply. No barge-in."
      />
      <View style={workshopStyles.statusRow}>
        <View style={[workshopStyles.statusDot, { backgroundColor: PHASE_COLOR[phase] }]} />
        <Text style={[workshopStyles.statusText, { color: colors.text }]}>
          {statusLabel}
        </Text>
      </View>
      {detail ? <Text style={styles.warning}>{detail}</Text> : null}
      <ScrollView style={styles.transcript} contentContainerStyle={styles.transcriptContent}>
        {entries.length === 0 ? (
          <Text style={[styles.muted, { color: colors.muted }]}>Connect, then speak a turn.</Text>
        ) : (
          entries.map((entry) => (
            <View key={entry.id} style={styles.entry}>
              <Text style={[styles.role, { color: colors.muted }]}>
                {entry.role === "user" ? "You" : "Assistant"}
              </Text>
              <Text style={[styles.entryText, { color: colors.text }]}>{entry.text}</Text>
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
            (phase !== "listening" || !draft.trim()) && workshopStyles.buttonDisabled,
          ]}
          onPress={sendText}
          disabled={phase !== "listening" || !draft.trim()}
        >
          <Text style={workshopStyles.sendLabel}>Send</Text>
        </Pressable>
      </View>
      <View style={[styles.diagnostics, { backgroundColor: colors.panel }]}>
        <Text style={[styles.diagnosticText, { color: colors.muted }]}>
          speaker route · capture: {captureInfo}
        </Text>
      </View>
      <Pressable
        style={[
          workshopStyles.callButton,
          (phase === "listening" || phase === "assistant" || phase === "connecting") &&
            workshopStyles.callButtonStop,
        ]}
        onPress={() => void connect()}
      >
        <Text style={workshopStyles.callLabel}>
          {phase === "idle" || phase === "error" ? "Connect" : "Disconnect"}
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  warning: { color: "#FF9F0A", fontSize: 13 },
  muted: { fontSize: 12, lineHeight: 17 },
  transcript: { flex: 1 },
  transcriptContent: { gap: 12, paddingVertical: 8 },
  entry: { gap: 2 },
  role: { fontSize: 12, fontWeight: "600" },
  entryText: { fontSize: 16 },
  diagnostics: { borderRadius: 8, gap: 2, padding: 8 },
  diagnosticText: { fontSize: 11, lineHeight: 16 },
});

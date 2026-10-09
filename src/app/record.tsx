import { useCallback, useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";

import {
  type AudioRoute,
  applyVoiceRoute,
  getRoutedDevice,
  getVoiceRoute,
  type AudioStreamProfile,
} from "@/lib/audio-engine";
import {
  RealtimeSession,
  type SessionDiagnostics,
  type SessionStatus,
  type TranscriptEntry,
} from "@/lib/realtime-session";
import {
  useWorkshopColors,
  WorkshopHeading,
  WORKSHOP_STATUS_COLOR,
  WorkshopSurface,
  workshopStyles,
} from "@/lib/workshop-ui";

type Mode = "text" | "voice";

const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  disconnecting: "Disconnecting",
  error: "Error",
};

// ThemeProvider only themes navigation chrome, so text needs explicit colors.
function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

/** Lower is better: it is how far our own audio rises above the room floor. */
function formatLeak(db: number | null): string {
  if (db === null) {
    return "--";
  }
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/** Normalize Android device labels for the diagnostics row. */
function formatDevice(device: string | null): string | null {
  return device === null ? null : device.toLowerCase().replace(/_/g, " ");
}

export type VoiceScreenProps = {
  audioStreamProfile: AudioStreamProfile;
  implementationName: string;
  implementationDescription: string;
};

export function VoiceScreen({
  audioStreamProfile,
  implementationName,
  implementationDescription,
}: VoiceScreenProps) {
  const colors = useWorkshopColors();
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("text");
  const [micOn, setMicOn] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<SessionDiagnostics | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [route, setRoute] = useState<AudioRoute>(getVoiceRoute);
  /** What Android reports it actually routed to, which can differ from the request. */
  const [routeInfo, setRouteInfo] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);

  const upsertEntry = useCallback((entry: TranscriptEntry) => {
    setEntries((current) => {
      const index = current.findIndex((item) => item.id === entry.id);
      const next = [...current];
      if (index === -1) {
        next.push(entry);
      } else {
        next[index] = entry;
      }
      // Transcripts arrive out of order, so keep conversation order here.
      return next.sort((a, b) => a.order - b.order);
    });
  }, []);

  const [session] = useState(() => {
    return new RealtimeSession({
      onStatus: (nextStatus, nextDetail) => {
        setStatus(nextStatus);
        setDetail(nextDetail ?? null);
        if (nextStatus !== "connected") {
          setUserSpeaking(false);
          setRouteInfo(null);
          return;
        }
        setRouteInfo(formatDevice(getRoutedDevice()));
      },
      onMicState: setMicOn,
      onTranscript: upsertEntry,
      onSpeechActivity: setUserSpeaking,
      onDiagnostics: setDiagnostics,
      onWarning: setWarning,
      audioStreamProfile,
    });
  });

  // Synchronize the selected interaction mode once the socket is ready. This
  // also honors a Voice selection made while the connection was still opening.
  useEffect(() => {
    if (status !== "connected") {
      return;
    }
    if (mode === "voice") {
      void session.startMic();
    } else {
      void session.stopMic();
    }
  }, [mode, session, status]);

  useEffect(() => {
    return () => {
      void session.disconnect();
    };
  }, [session]);

  // Native tabs retain their screens. End a hidden call so its stream cannot
  // overlap the other comparison profile.
  useFocusEffect(
    useCallback(() => {
      return () => {
        void session.disconnect();
      };
    }, [session]),
  );

  const isBusy = status === "connecting" || status === "disconnecting";
  const isLive = status === "connected";

  const toggleConnection = useCallback(() => {
    if (isLive || isBusy) {
      void session.disconnect();
      return;
    }

    setEntries([]);
    setDetail(null);
    setWarning(null);
    void session.connect();
  }, [isBusy, isLive, session]);

  const sendDraft = useCallback(() => {
    session.sendText(draft);
    setDraft("");
  }, [draft, session]);

  const chooseRoute = useCallback(async (next: AudioRoute) => {
    setRoute(next);
    setWarning(null);

    try {
      const selected = await applyVoiceRoute(next);
      if (selected === null) {
        // No live session to route yet; the choice applies on connect.
        setRouteInfo(null);
        return;
      }

      setRouteInfo(formatDevice(selected));
      const honored = selected === next;
      if (!honored) {
        setWarning(
          `Android kept ${selected}: the requested communication device was not selected`
        );
      }
    } catch (error) {
      setWarning(
        `Could not switch output: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, []);

  const hasDiagnostics =
    diagnostics !== null &&
    (diagnostics.micChunks > 0 ||
      diagnostics.recentEvents.length > 0 ||
      diagnostics.closeInfo !== null);

  const content = (
    <View style={workshopStyles.content}>
      <WorkshopHeading
        title={implementationName}
        description={implementationDescription}
      />
      <View style={workshopStyles.statusRow}>
        <View style={[workshopStyles.statusDot, { backgroundColor: WORKSHOP_STATUS_COLOR[status] }]} />
        <Text style={[workshopStyles.statusText, { color: colors.text }]}>
          {STATUS_LABEL[status]}
        </Text>
        {isLive ? (
          <Text style={[styles.activityText, { color: colors.muted }]}>
            {micOn ? (userSpeaking ? "hearing speech" : "listening") : "mic off"}
          </Text>
        ) : null}
      </View>

      {detail ? <Text style={styles.detailText}>{detail}</Text> : null}
      {warning ? <Text style={styles.warningText}>{warning}</Text> : null}

      <ScrollView
        ref={scrollRef}
        style={styles.transcript}
        contentContainerStyle={styles.transcriptContent}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {entries.length === 0 ? (
          <Text style={[styles.placeholder, { color: colors.muted }]}>
            Connect, then pick Text to type or Voice to talk.
          </Text>
        ) : (
          entries.map((entry) => (
            <View key={entry.id} style={styles.entry}>
              <Text style={[styles.entryRole, { color: colors.muted }]}>
                {entry.role === "user" ? "You" : "Assistant"}
              </Text>
              <Text style={[styles.entryText, { color: colors.text }]}>{entry.text}</Text>
            </View>
          ))
        )}
      </ScrollView>

      {hasDiagnostics && diagnostics ? (
        <Pressable
          style={[styles.debugPanel, { backgroundColor: colors.panel }]}
          onPress={() => setDebugOpen((current) => !current)}
        >
          <Text
            style={[styles.debugText, { color: colors.muted }]}
            numberOfLines={1}
          >
            {`mic ${diagnostics.micChunks} · vad ${diagnostics.speechTriggers}/${diagnostics.triggersWhileSpeaking}/${diagnostics.confirmedEchoes} · leak ${formatLeak(
              diagnostics.echoLeakDb
            )}${diagnostics.playbackAudible ? " · spk ON" : ""} · ${
              debugOpen ? "hide" : "details"
            }`}
          </Text>
          {debugOpen ? (
            <ScrollView style={styles.debugScroll} nestedScrollEnabled>
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`mic ${diagnostics.micChunks} chunks / ${formatBytes(diagnostics.micBytes)}`}
              </Text>
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`audio ${diagnostics.audioDeltas} deltas / ${diagnostics.buffersQueued} queued / ${diagnostics.buffersEnded} ended`}
              </Text>
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`playback ${diagnostics.playbackState} / context ${diagnostics.contextState}`}
              </Text>
              {diagnostics.lastBufferInfo ? (
                <Text style={[styles.debugText, { color: colors.muted }]}>
                  {`buffer ${diagnostics.lastBufferInfo}`}
                </Text>
              ) : null}
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`levels mic rms ${diagnostics.micRms.toFixed(4)} / quiet baseline ${diagnostics.micBaseline.toFixed(4)}${
                  diagnostics.playbackAudible ? " / speaker ON" : ""
                }`}
              </Text>
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`echo ${diagnostics.echoLevel.toFixed(4)} while speaking = ${formatLeak(
                  diagnostics.echoLeakDb
                )} over floor`}
              </Text>
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`vad ${diagnostics.speechTriggers} triggers, ${diagnostics.triggersWhileSpeaking} while speaker on, ${diagnostics.confirmedEchoes} echo`}
              </Text>
              {diagnostics.lastIncident ? (
                <Text style={[styles.debugText, { color: colors.muted }]}>
                  {`last ${diagnostics.lastIncident}`}
                </Text>
              ) : null}
              <Text style={[styles.debugText, { color: colors.muted }]}>
                {`events ${diagnostics.recentEvents.join(", ") || "none yet"}`}
              </Text>
              {diagnostics.captureInfo ? (
                <Text style={[styles.debugText, { color: colors.muted }]}>
                  {`capture ${diagnostics.captureInfo}`}
                </Text>
              ) : null}
              {diagnostics.closeInfo ? (
                <Text style={[styles.debugText, { color: colors.muted }]}>
                  {`closed ${diagnostics.closeInfo}`}
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </Pressable>
      ) : null}

      <View style={workshopStyles.composer}>
        <TextInput
          style={[
            workshopStyles.input,
            { color: colors.text, borderColor: colors.border, backgroundColor: colors.field },
          ]}
          value={draft}
          onChangeText={setDraft}
          placeholder="Type a message"
          placeholderTextColor={colors.placeholder}
          returnKeyType="send"
          onSubmitEditing={sendDraft}
        />
        <Pressable
          style={[workshopStyles.sendButton, !draft.trim() && workshopStyles.buttonDisabled]}
          onPress={sendDraft}
          disabled={!draft.trim()}
        >
          <Text style={workshopStyles.sendLabel}>Send</Text>
        </Pressable>
      </View>

      <View style={workshopStyles.utilityRow}>
        {(["earpiece", "speaker"] as const).map((option) => {
          const selected = route === option;
          return (
            <Pressable
              key={option}
              style={[
                workshopStyles.utilityButton,
                { borderColor: colors.border },
                selected && workshopStyles.utilityButtonActive,
              ]}
              // Switchable mid-call: routing is independent of the streams.
              onPress={() => void chooseRoute(option)}
            >
              <Text
                style={[
                  workshopStyles.utilityLabel,
                  { color: selected ? "white" : colors.text },
                ]}
              >
                {option === "earpiece" ? "Phone" : "Speaker"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {routeInfo ? (
        <Text style={[styles.routeInfoText, { color: colors.muted }]}>
          {`output: ${routeInfo}`}
        </Text>
      ) : null}

      <View style={[workshopStyles.modeRow, { borderColor: colors.border }]}>
        {(["text", "voice"] as const).map((option) => {
          const selected = mode === option;
          return (
            <Pressable
              key={option}
              style={[workshopStyles.modeButton, selected && workshopStyles.modeButtonSelected]}
              onPress={() => setMode(option)}
            >
              <Text
                style={[
                  workshopStyles.modeLabel,
                  { color: selected ? "white" : colors.text },
                ]}
              >
                {option === "text" ? "Text" : "Voice"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        style={[
          workshopStyles.callButton,
          isLive || isBusy ? workshopStyles.callButtonStop : null,
          status === "disconnecting" && workshopStyles.buttonDisabled,
        ]}
        onPress={toggleConnection}
        disabled={status === "disconnecting"}
      >
        <Text style={workshopStyles.callLabel}>
          {status === "disconnecting" ? "Disconnecting" : isBusy ? "Connecting" : isLive ? "Disconnect" : "Connect"}
        </Text>
      </Pressable>
    </View>
  );

  return <WorkshopSurface>{content}</WorkshopSurface>;
}

export default function PatchedVoiceScreen() {
  return (
    <VoiceScreen
      audioStreamProfile="voice-processing"
      implementationName="Patched voice-processing audio"
      implementationDescription="Communication streams with platform voice processing enabled."
    />
  );
}

const styles = StyleSheet.create({
  activityText: {
    fontSize: 14,
    opacity: 0.6,
  },
  detailText: {
    fontSize: 13,
    color: "#FF453A",
  },
  warningText: {
    fontSize: 13,
    color: "#FF9F0A",
  },
  debugPanel: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 2,
  },
  // Expanded diagnostics scroll instead of pushing the transcript off screen.
  debugScroll: {
    maxHeight: 120,
  },
  debugText: {
    fontSize: 10,
    lineHeight: 14,
  },
  transcript: {
    flex: 1,
  },
  transcriptContent: {
    gap: 12,
    paddingVertical: 8,
  },
  placeholder: {
    opacity: 0.5,
  },
  entry: {
    gap: 2,
  },
  entryRole: {
    fontSize: 12,
    fontWeight: "600",
    opacity: 0.5,
  },
  entryText: {
    fontSize: 16,
  },
  routeInfoText: {
    fontSize: 11,
  },
});

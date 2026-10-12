import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { Platform, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { File } from "expo-file-system";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
} from "expo-audio";

import { resolveServerBaseUrl } from "@/lib/token-url";
import { serializeAudioLifecycle } from "@/lib/audio-lifecycle";
import {
  useWorkshopColors,
  WorkshopHeading,
  workshopStyles,
} from "@/lib/workshop-ui";

type RecordingSource = "mic" | "voice_communication";
type DiagnosticResult = {
  source: RecordingSource;
  peakCorrelation: number;
  estimatedLagMs: number;
  echoGainDb: number;
  capturedMs: number;
};

type AecDiagnosticProps = {
  initialDetail: string | null;
  onRunStarted: () => void;
  onCancelled: () => void;
};

const CANCELLED_RUN = "AEC diagnostic cancelled";

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function AecDiagnostic({
  initialDetail,
  onRunStarted,
  onCancelled,
}: AecDiagnosticProps) {
  const colors = useWorkshopColors();
  const [running, setRunning] = useState(false);
  const [detail, setDetail] = useState<string | null>(initialDetail);
  const [results, setResults] = useState<DiagnosticResult[]>([]);
  const runEpochRef = useRef(0);
  const runActiveRef = useRef(false);
  const activeFileRef = useRef<File | null>(null);
  const captureCleanupRef = useRef<Promise<void> | null>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const player = useAudioPlayer(null, { downloadFirst: false });

  const releaseCapture = useCallback(() => {
    if (captureCleanupRef.current) {
      return captureCleanupRef.current;
    }

    const cleanup = serializeAudioLifecycle(async () => {
      player.pause();
      if (recorder.isRecording) {
        try {
          await recorder.stop();
        } catch {
          // A cancellation can race the recorder's normal completion path.
        }
      }
      const recordingFile = activeFileRef.current ?? (
        recorder.uri ? new File(recorder.uri) : null
      );
      activeFileRef.current = null;
      if (recordingFile?.exists) {
        recordingFile.delete();
      }
    });

    captureCleanupRef.current = cleanup;
    const clearCleanup = () => {
      if (captureCleanupRef.current === cleanup) {
        captureCleanupRef.current = null;
      }
    };
    void cleanup.then(clearCleanup, clearCleanup);
    return cleanup;
  }, [player, recorder]);

  const cancelRun = useCallback(() => {
    const wasRunning = runActiveRef.current;
    runEpochRef.current += 1;
    runActiveRef.current = false;
    void releaseCapture();
    return wasRunning;
  }, [releaseCapture]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (cancelRun()) {
          setResults([]);
          setDetail("Diagnostic cancelled when leaving the experiment.");
          onCancelled();
        }
      };
    }, [cancelRun, onCancelled]),
  );

  const ensureCurrentRun = useCallback((runEpoch: number) => {
    if (runEpoch !== runEpochRef.current) {
      throw new Error(CANCELLED_RUN);
    }
  }, []);

  const runCapture = useCallback(
    async (source: RecordingSource, runEpoch: number): Promise<DiagnosticResult> => {
      const startResponse = await fetch(`${resolveServerBaseUrl()}/aec-probe/start`, {
        method: "POST",
      });
      ensureCurrentRun(runEpoch);
      if (!startResponse.ok) {
        throw new Error(`Could not create probe (${startResponse.status})`);
      }
      const probe = (await startResponse.json()) as {
        id: string;
        url: string;
        durationMs: number;
      };
      let recordingFile: File | null = null;
      try {
        await serializeAudioLifecycle(async () => {
          ensureCurrentRun(runEpoch);
          await recorder.prepareToRecordAsync({
            ...RecordingPresets.HIGH_QUALITY,
            numberOfChannels: 1,
            bitRate: 64_000,
            android: {
              ...RecordingPresets.HIGH_QUALITY.android,
              audioSource: source,
            },
          });
          ensureCurrentRun(runEpoch);
          recorder.record();
          player.replace({ uri: probe.url });
          player.play();
        });
        await new Promise((resolve) => setTimeout(resolve, probe.durationMs + 2_500));
        ensureCurrentRun(runEpoch);
        await serializeAudioLifecycle(async () => {
          ensureCurrentRun(runEpoch);
          await recorder.stop();
        });
        ensureCurrentRun(runEpoch);
        if (!recorder.uri) {
          throw new Error("Expo Audio did not return a diagnostic recording URI");
        }
        recordingFile = new File(recorder.uri);
        activeFileRef.current = recordingFile;
        const upload = await fetch(
          `${resolveServerBaseUrl()}/aec-probe/${probe.id}/capture/${source}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: await recordingFile.arrayBuffer(),
          },
        );
        ensureCurrentRun(runEpoch);
        const result = (await upload.json()) as DiagnosticResult & { error?: string };
        if (!upload.ok) {
          throw new Error(result.error ?? `Could not analyse probe (${upload.status})`);
        }
        return result;
      } finally {
        await releaseCapture();
      }
    },
    [ensureCurrentRun, player, recorder, releaseCapture],
  );

  const runComparison = useCallback(async () => {
    if (Platform.OS !== "android" || running) {
      return;
    }
    const runEpoch = ++runEpochRef.current;
    runActiveRef.current = true;
    onRunStarted();
    setRunning(true);
    setDetail("Keep the phone still, loudspeaker volume fixed, and stay quiet. Running 6 captures…");
    setResults([]);
    try {
      const permission = await requestRecordingPermissionsAsync();
      ensureCurrentRun(runEpoch);
      if (!permission.granted) {
        throw new Error("Microphone permission was denied");
      }
      await serializeAudioLifecycle(async () => {
        ensureCurrentRun(runEpoch);
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: "doNotMix",
          shouldRouteThroughEarpiece: false,
        });
      });
      ensureCurrentRun(runEpoch);
      const nextResults: DiagnosticResult[] = [];
      for (const source of ["mic", "voice_communication"] as const) {
        for (let run = 0; run < 3; run += 1) {
          ensureCurrentRun(runEpoch);
          setDetail(`Running ${source.replace("_", " ")} capture ${run + 1} of 3…`);
          const result = await runCapture(source, runEpoch);
          ensureCurrentRun(runEpoch);
          nextResults.push(result);
          setResults([...nextResults]);
        }
      }
      setDetail("Complete. Results are device-specific evidence, not proof that AEC is enabled.");
    } catch (error) {
      if (runEpoch === runEpochRef.current) {
        setDetail(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (runEpoch === runEpochRef.current) {
        runActiveRef.current = false;
        setRunning(false);
      } else if (!runActiveRef.current) {
        // Keep Run disabled until the cancelled task's finally block has
        // stopped/deleted its capture, even if this tab is already visible.
        setRunning(false);
      }
    }
  }, [ensureCurrentRun, onRunStarted, runCapture, running]);

  if (Platform.OS !== "android") {
    return (
      <WorkshopHeading
        title="Android AEC diagnostic"
        description="voice_communication is an Android recorder source, so this experiment is unavailable on this platform."
      />
    );
  }

  const micMedian = median(
    results
      .filter((result) => result.source === "mic")
      .map((result) => result.echoGainDb),
  );
  const voiceMedian = median(
    results
      .filter((result) => result.source === "voice_communication")
      .map((result) => result.echoGainDb),
  );
  const improvement = micMedian !== null && voiceMedian !== null
    ? micMedian - voiceMedian
    : null;

  return (
    <>
      <WorkshopHeading
        title="Android recorder AEC diagnostic"
        description="Three mic and three voice_communication captures through the loudspeaker. Temporary M4A files are uploaded once and deleted immediately."
      />
      <Text style={[styles.instructions, { color: colors.text }]}>
        Set the same loudspeaker volume, lay the phone still, and do not speak during the 6 captures.
      </Text>
      {detail ? (
        <Text style={[styles.muted, { color: colors.muted }]}>{detail}</Text>
      ) : null}
      <ScrollView
        style={styles.results}
        contentContainerStyle={styles.resultsContent}
      >
        {results.map((result, index) => {
          const runNumber = results
            .filter((entry) => entry.source === result.source)
            .indexOf(result) + 1;

          return (
            <Text
              key={`${result.source}-${index}`}
              style={[styles.diagnosticText, { color: colors.text }]}
            >
              {`${result.source.replace("_", " ")} #${runNumber}: `}
              {`correlation ${result.peakCorrelation} · ${result.echoGainDb} dB · ${result.estimatedLagMs} ms`}
            </Text>
          );
        })}
      </ScrollView>
      {improvement !== null ? (
        <Text style={[styles.summary, { color: colors.text }]}>
          Median echo gain: mic {micMedian?.toFixed(1)} dB
          {" · voice communication "}{voiceMedian?.toFixed(1)} dB
          {" · reduction "}{improvement.toFixed(1)} dB
          {improvement >= 10
            ? " (interesting device-specific result)"
            : " (no ≥10 dB benefit)"}
        </Text>
      ) : null}
      <Pressable
        style={[workshopStyles.callButton, running && workshopStyles.buttonDisabled]}
        onPress={() => void runComparison()}
        disabled={running}
      >
        <Text style={workshopStyles.callLabel}>
          {running ? "Running diagnostic…" : "Run 6-capture comparison"}
        </Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  muted: { fontSize: 12, lineHeight: 17 },
  instructions: { fontSize: 13, lineHeight: 18 },
  results: { flex: 1 },
  resultsContent: { gap: 12, paddingVertical: 8 },
  diagnosticText: { fontSize: 11, lineHeight: 16 },
  summary: { fontSize: 13, fontWeight: "600", lineHeight: 19 },
});

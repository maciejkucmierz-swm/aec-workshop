import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { AecDiagnostic } from "@/components/expo-audio/aec-diagnostic";
import { ExpoVoiceAgent } from "@/components/expo-audio/voice-agent";
import {
  useWorkshopColors,
  WorkshopSurface,
  workshopStyles,
} from "@/lib/workshop-ui";

type AlternativeMode = "half-duplex" | "aec-diagnostic";

export default function ExpoAlternativesScreen() {
  const colors = useWorkshopColors();
  const [mode, setMode] = useState<AlternativeMode>("half-duplex");
  const [diagnosticNotice, setDiagnosticNotice] = useState<string | null>(null);

  const clearDiagnosticNotice = useCallback(() => setDiagnosticNotice(null), []);
  const noteDiagnosticCancellation = useCallback(
    () => setDiagnosticNotice("Diagnostic cancelled when leaving the experiment."),
    [],
  );

  return (
    <WorkshopSurface>
      <View style={workshopStyles.content}>
        <View style={[workshopStyles.modeRow, { borderColor: colors.border }]}>
          {(["half-duplex", "aec-diagnostic"] as const).map((option) => (
            <Pressable
              key={option}
              style={[
                workshopStyles.modeButton,
                mode === option && workshopStyles.modeButtonSelected,
              ]}
              onPress={() => setMode(option)}
            >
              <Text
                style={[
                  workshopStyles.modeLabel,
                  { color: mode === option ? "white" : colors.text },
                ]}
              >
                {option === "half-duplex" ? "Half duplex" : "AEC diagnostic"}
              </Text>
            </Pressable>
          ))}
        </View>
        {mode === "half-duplex" ? <ExpoVoiceAgent mode="half-duplex" /> : null}
        {mode === "aec-diagnostic" ? (
          <AecDiagnostic
            initialDetail={diagnosticNotice}
            onRunStarted={clearDiagnosticNotice}
            onCancelled={noteDiagnosticCancellation}
          />
        ) : null}
      </View>
    </WorkshopSurface>
  );
}

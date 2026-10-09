import { type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export type WorkshopColors = typeof WORKSHOP_PALETTE.dark;

const WORKSHOP_PALETTE = {
  light: {
    background: "#FFFFFF",
    text: "#11181C",
    muted: "#687076",
    border: "#C6C9CC",
    field: "#FFFFFF",
    placeholder: "#8E8E93",
    panel: "#F1F3F5",
  },
  dark: {
    background: "#000000",
    text: "#F5F5F7",
    muted: "#B0B0BA",
    border: "#303036",
    field: "#19191B",
    placeholder: "#8E8E93",
    panel: "#141416",
  },
};

export const WORKSHOP_STATUS_COLOR = {
  idle: "#8E8E93",
  connecting: "#FF9F0A",
  disconnecting: "#FF9F0A",
  connected: "#30D158",
  error: "#FF453A",
} as const;

export function useWorkshopColors(): WorkshopColors {
  return WORKSHOP_PALETTE[useColorScheme() === "dark" ? "dark" : "light"];
}

/** The shared visual shell for every workshop comparison tab. */
export function WorkshopSurface({ children }: { children: ReactNode }) {
  const colors = useWorkshopColors();

  return (
    <SafeAreaView
      style={[workshopStyles.safeArea, { backgroundColor: colors.background }]}
      edges={Platform.OS === "ios" ? ["top", "bottom"] : ["top"]}
    >
      <KeyboardAvoidingView
        style={workshopStyles.screen}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {children}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Shared title treatment for every workshop experiment. */
export function WorkshopHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  const colors = useWorkshopColors();

  return (
    <View>
      <Text style={[workshopStyles.heading, { color: colors.text }]}>
        {title}
      </Text>
      <Text style={[workshopStyles.description, { color: colors.muted }]}>
        {description}
      </Text>
    </View>
  );
}

export const workshopStyles = StyleSheet.create({
  safeArea: { flex: 1 },
  screen: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  content: { flex: 1, gap: 8 },
  heading: { fontSize: 17, fontWeight: "700" },
  description: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 16, fontWeight: "600" },
  composer: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
  },
  sendButton: {
    borderRadius: 8,
    backgroundColor: "#208AEF",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  sendLabel: { color: "white", fontSize: 13, fontWeight: "600" },
  buttonDisabled: { opacity: 0.4 },
  utilityRow: { flexDirection: "row", gap: 8 },
  utilityButton: {
    flex: 1,
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 5,
  },
  utilityButtonActive: { backgroundColor: "#208AEF" },
  utilityLabel: { fontSize: 12, fontWeight: "600" },
  modeRow: {
    flexDirection: "row",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 9,
    padding: 2,
    gap: 2,
  },
  modeButton: { flex: 1, alignItems: "center", paddingVertical: 5, borderRadius: 7 },
  modeButtonSelected: { backgroundColor: "#208AEF" },
  modeLabel: { fontSize: 13, fontWeight: "600" },
  callButton: {
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#208AEF",
    marginBottom: 12,
  },
  callButtonStop: { backgroundColor: "#FF453A" },
  callLabel: { color: "white", fontSize: 16, fontWeight: "600" },
});

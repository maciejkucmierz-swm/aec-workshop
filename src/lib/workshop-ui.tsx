import { type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-screens/experimental";
import { IS_PROMO } from "@/lib/app-mode";
import { PROMO_LAYOUT } from "@/lib/promo-ui";
import { APP_PALETTE, type AppColors, useAppAppearance, useAppColors } from "@/lib/theme";

export { useAppColors as useWorkshopColors, useAppColors as useScreenColors } from "@/lib/theme";

export function useWorkshopStyles() {
  return WORKSHOP_STYLES[useAppAppearance()];
}

/** The shared visual shell for every workshop comparison tab. */
export function WorkshopSurface({ children }: { children: ReactNode }) {
  const colors = useAppColors();
  const workshopStyles = useWorkshopStyles();

  return (
    <SafeAreaView
      collapsable={false}
      style={[workshopStyles.safeArea, { backgroundColor: colors.background }]}
      // Native tab insets include the bar, not just the device's home indicator.
      // This shell owns them on both platforms; automatic tab insets are disabled.
      edges={{ top: true, bottom: true, left: true, right: true }}
    >
      <KeyboardAvoidingView
        style={workshopStyles.safeArea}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* KeyboardAvoidingView replaces its own bottom padding on iOS. */}
        <View style={[
          workshopStyles.screen,
          IS_PROMO && { paddingHorizontal: PROMO_LAYOUT.gutter },
        ]}>
          {children}
        </View>
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
  const colors = useAppColors();
  const workshopStyles = useWorkshopStyles();

  if (IS_PROMO) {
    return null;
  }

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

function createWorkshopStyles(colors: AppColors) {
  return StyleSheet.create({
    safeArea: { flex: 1 },
    screen: { flex: 1, paddingHorizontal: 16, paddingVertical: 12 },
    content: { flex: 1, gap: 8 },
    heading: { fontSize: 17, fontWeight: "700" },
    description: { fontSize: 12, lineHeight: 17, marginTop: 2 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    statusDot: { width: 10, height: 10, borderRadius: 5 },
    statusText: { fontSize: 16, fontWeight: "600" },
    placeholder: { fontSize: 14 },
    entryRole: { fontSize: 12, fontWeight: "600" },
    entryText: { fontSize: 16 },
    activityText: { fontSize: 14 },
    detailText: { fontSize: 13, color: colors.error },
    warningText: { fontSize: 13, color: colors.warning },
    debugText: { fontSize: 10, lineHeight: 14 },
    diagnosticText: { fontSize: 11, lineHeight: 16 },
    routeInfoText: { fontSize: 11 },
    supportingText: { fontSize: 12, lineHeight: 17 },
    instructions: { fontSize: 13, lineHeight: 18 },
    summary: { fontSize: 13, fontWeight: "600", lineHeight: 19 },
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
      backgroundColor: colors.accent,
      justifyContent: "center",
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    sendLabel: { color: colors.accentText, fontSize: 13, fontWeight: "600" },
    buttonDisabled: { opacity: 0.4 },
    modeRow: {
      flexDirection: "row",
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 9,
      padding: 2,
      gap: 2,
    },
    modeButton: { flex: 1, alignItems: "center", paddingVertical: 5, borderRadius: 7 },
    modeButtonSelected: { backgroundColor: colors.accent },
    modeLabel: { fontSize: 13, fontWeight: "600" },
    callButton: {
      alignItems: "center",
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: colors.button,
    },
    callButtonStop: { backgroundColor: colors.endButton },
    callLabel: { color: colors.buttonText, fontSize: 16, fontWeight: "600" },
    callLabelStop: { color: colors.endText },
  });
}

const WORKSHOP_STYLES = {
  light: createWorkshopStyles(APP_PALETTE.light),
  dark: createWorkshopStyles(APP_PALETTE.dark),
};

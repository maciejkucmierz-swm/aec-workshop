import { StyleSheet } from "react-native";
import type { PromoOrbState } from "@/components/promo-orb/types";

export { useAppColors as usePromoColors } from "@/lib/theme";

export type PromoConnectionState = "idle" | "connecting" | "connected" | "disconnecting" | "error";
export type PromoTranscriptEntry = { id: string; role: "user" | "assistant"; text: string };

export function getPromoPresentation(
  connection: PromoConnectionState,
  microphoneActive: boolean,
  assistantPlaying: boolean,
) {
  const active = connection === "connected";
  const orbState: PromoOrbState = connection === "connecting" ? "idle" : !active ? connection
    : assistantPlaying ? "speaking" : microphoneActive ? "listening" : "paused";
  const status = connection === "idle" ? "Ready"
    : connection === "connecting" ? "Connecting…"
    : connection === "disconnecting" ? "Ending…"
    : connection === "error" ? "Couldn’t connect"
    : assistantPlaying ? "Speaking" : microphoneActive ? "Listening" : "Microphone paused";
  const buttonLabel = connection === "connecting" ? "Cancel"
    : connection === "disconnecting" ? "Ending…" : active ? "End chat" : "Start talking";
  return { orbState, status, buttonLabel, disabled: connection === "disconnecting" };
}

export function latestPromoEntry(entries: readonly PromoTranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].text.trim()) return entries[index];
  }
  return undefined;
}

export const PROMO_LAYOUT = {
  gutter: 24,
  maxOrbSize: 281,
  detailHeight: 44,
  minCaptionHeight: 112,
  topSpace: 80,
  stageGap: 12,
};

export const PROMO_FONTS = {
  regular: "Manrope_400Regular",
  medium: "Manrope_500Medium",
} as const;

export const promoStyles = StyleSheet.create({
  screen: { flex: 1 },
  detail: { fontFamily: PROMO_FONTS.regular, fontSize: 13, lineHeight: 18, textAlign: "center" },
  role: { fontFamily: PROMO_FONTS.medium, fontSize: 12, lineHeight: 18 },
  caption: { fontFamily: PROMO_FONTS.regular, fontSize: 21, lineHeight: 29, textAlign: "center" },
  assistantCaption: { fontSize: 25, lineHeight: 34 },
  buttonLabel: { fontFamily: PROMO_FONTS.medium, fontSize: 16, lineHeight: 22 },
});

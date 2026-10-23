import { useEffect, useRef, useState } from "react";
import { useIsFocused } from "expo-router";
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";

import { PromoOrb } from "@/components/promo-orb";
import {
  getPromoPresentation,
  latestPromoEntry,
  PROMO_LAYOUT,
  promoStyles,
  type PromoConnectionState,
  type PromoTranscriptEntry,
  usePromoColors,
} from "@/lib/promo-ui";

type PromoVoiceScreenProps = {
  connection: PromoConnectionState;
  microphoneActive: boolean;
  userSpeaking: boolean;
  assistantPlaying: boolean;
  entries: readonly PromoTranscriptEntry[];
  error?: string | null;
  warning?: string | null;
  onToggleConnection: () => void;
};

/** Presentation only: the calling screen retains its audio/session ownership. */
export function PromoVoiceScreen({
  connection, microphoneActive, userSpeaking, assistantPlaying, entries, error, warning, onToggleConnection,
}: PromoVoiceScreenProps) {
  const colors = usePromoColors();
  const focused = useIsFocused();
  const { width, height, fontScale } = useWindowDimensions();
  const [availableHeight, setAvailableHeight] = useState(height * 0.75);
  const presentation = getPromoPresentation(connection, microphoneActive, assistantPlaying);
  const latest = latestPromoEntry(entries);
  const detail = [error, warning].filter(Boolean).join("\n");
  const textScale = Math.max(1, fontScale);
  const topSpaceHeight = Math.min(PROMO_LAYOUT.topSpace, availableHeight * 0.14);
  const detailHeight = Math.min(PROMO_LAYOUT.detailHeight * textScale, availableHeight * 0.16);
  const minCaptionHeight = Math.min(PROMO_LAYOUT.minCaptionHeight * textScale, availableHeight * 0.32);
  const reservedHeight = topSpaceHeight + detailHeight + minCaptionHeight +
    PROMO_LAYOUT.stageGap;
  const orbSize = Math.max(44, Math.min(
    PROMO_LAYOUT.maxOrbSize, width - PROMO_LAYOUT.gutter * 2, availableHeight - reservedHeight,
  ));

  return (
    <View
      style={promoStyles.screen}
      onLayout={({ nativeEvent }) => setAvailableHeight(nativeEvent.layout.height)}
    >
      <View style={styles.stage}>
        <View style={{ height: topSpaceHeight }} />
        <PromoOrb
          state={presentation.orbState}
          size={orbSize}
          containerHeight={availableHeight}
          hearing={presentation.orbState === "listening" && userSpeaking}
          onPress={onToggleConnection}
          accessibilityLabel={`${presentation.buttonLabel}. ${presentation.status}`}
          disabled={presentation.disabled || !focused}
        />
        <View style={[styles.detailSlot, { height: detailHeight }]}>
          {detail ? (
            <ScrollView nestedScrollEnabled contentContainerStyle={styles.detailContent}>
              <Text style={[promoStyles.detail, { color: colors.error }]}>{detail}</Text>
            </ScrollView>
          ) : null}
        </View>
        <View style={[styles.captionSlot, { minHeight: minCaptionHeight }]}>
          {latest ? (
            <PromoCaption key={latest.id} entry={latest} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

const CAPTION_ENTER = FadeIn.duration(500).reduceMotion(ReduceMotion.System);

function PromoCaption({ entry }: { entry: PromoTranscriptEntry }) {
  const colors = usePromoColors();
  const focused = useIsFocused();
  const scrollRef = useRef<ScrollView>(null);
  const followTail = useRef(true);
  const [visibleWords, setVisibleWords] = useState(0);
  const words = entry.text.match(/\s*\S+\s*/g) ?? [];
  const revealing = entry.role === "assistant" && visibleWords < words.length;
  const caption = entry.role === "assistant" ? words.slice(0, visibleWords).join("") : entry.text;

  useEffect(() => {
    if (!focused || !revealing) return;
    // Approximate speech pace; incoming transcript updates must not restart the clock.
    const timer = setInterval(() => setVisibleWords((count) => count + 1), 320);
    return () => clearInterval(timer);
  }, [focused, revealing]);

  return (
    <Animated.View entering={CAPTION_ENTER} style={styles.caption}>
      <Text style={[promoStyles.role, { color: colors.muted }]}>
        {entry.role === "user" ? "You" : "Assistant"}
      </Text>
      <ScrollView
        ref={scrollRef}
        style={styles.captionScroll}
        contentContainerStyle={styles.captionContent}
        nestedScrollEnabled
        onScroll={({ nativeEvent: { contentOffset, layoutMeasurement, contentSize } }) => {
          followTail.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
        }}
        scrollEventThrottle={16}
        onContentSizeChange={() => {
          if (followTail.current) scrollRef.current?.scrollToEnd({ animated: false });
        }}
      >
        <Text style={[
          promoStyles.caption,
          entry.role === "assistant" && promoStyles.assistantCaption,
          { color: colors.text },
        ]}>
          {caption}
        </Text>
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1 },
  detailSlot: { marginTop: PROMO_LAYOUT.stageGap },
  detailContent: { paddingVertical: 4 },
  captionSlot: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  caption: { flex: 1, alignItems: "center", gap: 6, width: "100%" },
  captionScroll: { flex: 1, width: "100%" },
  captionContent: { flexGrow: 1, paddingVertical: 2 },
});

import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import Animated from "react-native-reanimated";
import { promoStyles, usePromoColors } from "@/lib/promo-ui";
import type { PromoOrbProps } from "./promo-orb/types";
import { useOrbTapAnimation } from "./promo-orb/use-tap-animation";

// Web keeps the existing presentation and never imports the native GPU module.
export function PromoOrbProvider({ children }: { children: ReactNode }) {
  return children;
}

export function PromoOrb({ size, onPress, accessibilityLabel, disabled }: PromoOrbProps) {
  const colors = usePromoColors();
  const { animatedStyle, pulse } = useOrbTapAnimation();
  // Native-only GPU rendering; keep the conversation control usable on web.
  return (
    <Animated.View style={[styles.frame, animatedStyle]}>
      <Pressable
        onPress={() => {
          if (disabled) return;
          pulse();
          onPress();
        }}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        style={[
          styles.control,
          { width: size, height: size, backgroundColor: colors.panel },
        ]}
      >
        <Text style={[promoStyles.buttonLabel, styles.label, { color: colors.text }]}>
          {accessibilityLabel}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { alignSelf: "center" },
  control: { alignSelf: "center", alignItems: "center", justifyContent: "center", borderRadius: 999 },
  label: { textAlign: "center", paddingHorizontal: 16 },
});

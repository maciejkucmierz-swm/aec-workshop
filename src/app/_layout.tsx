import { Manrope_400Regular } from "@expo-google-fonts/manrope/400Regular";
import { Manrope_500Medium } from "@expo-google-fonts/manrope/500Medium";
import { useFonts, type FontSource } from "expo-font";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Platform, useColorScheme } from "react-native";

import { PromoOrbProvider } from "@/components/promo-orb";
import { IS_PROMO } from "@/lib/app-mode";
import { PROMO_FONTS } from "@/lib/promo-ui";
import { useScreenColors } from "@/lib/workshop-ui";

const promoFontAssets: Record<string, FontSource> = IS_PROMO ? {
  [PROMO_FONTS.regular]: Manrope_400Regular,
  [PROMO_FONTS.medium]: Manrope_500Medium,
} : {};

if (IS_PROMO) SplashScreen.preventAutoHideAsync();

const TABS = {
  index: {
    label: IS_PROMO ? "RNAA 1.X" : "Voice",
    sf: { default: "mic", selected: "mic.fill" },
    md: { default: "mic_none", selected: "mic" },
  },
  "record-unpatched": {
    label: IS_PROMO ? "RNAA 0.X" : "Defaults",
    sf: { default: "mic.slash", selected: "mic.slash.fill" },
    md: { default: "mic_off", selected: "mic_off" },
  },
  "record-media-output": {
    label: "Media",
    sf: { default: "speaker.wave.2", selected: "speaker.wave.2.fill" },
    md: { default: "volume_up", selected: "volume_up" },
  },
  "expo-alternatives": {
    label: "Expo",
    sf: { default: "waveform.path.ecg", selected: "waveform.path.ecg" },
    md: { default: "science", selected: "science" },
  },
  "expo-duplex": {
    label: IS_PROMO ? "Expo" : "Duplex",
    sf: { default: "waveform", selected: "waveform" },
    md: { default: "graphic_eq", selected: "graphic_eq" },
  },
} as const;

const TAB_ORDER = IS_PROMO
  ? ([
      "record-unpatched",
      "expo-duplex",
      "index",
      "record-media-output",
      "expo-alternatives",
    ] as const)
  : ([
      "index",
      "record-unpatched",
      "record-media-output",
      "expo-alternatives",
      "expo-duplex",
    ] as const);

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(promoFontAssets);
  const colorScheme = useColorScheme();
  const colors = useScreenColors();
  useEffect(() => {
    if (IS_PROMO && (fontsLoaded || fontError)) SplashScreen.hide();
  }, [fontsLoaded, fontError]);

  const baseTheme = colorScheme === "dark" ? DarkTheme : DefaultTheme;
  const tint = IS_PROMO ? colors.text : colors.accent;
  const theme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      background: colors.background,
      card: colors.background,
      text: colors.text,
      border: colors.border,
      primary: tint,
      notification: colors.error,
    },
  };

  if (IS_PROMO && !fontsLoaded && !fontError) return null;

  return (
    <ThemeProvider value={theme}>
      <PromoOrbProvider>
        {/* iOS 26 supplies Liquid Glass; older iOS uses the native frosted material. */}
        <NativeTabs
          minimizeBehavior="never"
          blurEffect="systemChromeMaterial"
          disableTransparentOnScrollEdge
          tintColor={tint}
          iconColor={{ default: colors.muted, selected: tint }}
          labelStyle={{
            default: { color: colors.muted, fontFamily: IS_PROMO ? PROMO_FONTS.medium : undefined },
            selected: { color: tint, fontFamily: IS_PROMO ? PROMO_FONTS.medium : undefined },
          }}
          backgroundColor={Platform.OS === "android" ? colors.panel : undefined}
          // The transition container must match the screens, not the system default.
          unstable_nativeProps={{
            nativeContainerStyle: { backgroundColor: colors.background },
          }}
          indicatorColor={colors.selection}
        >
          {TAB_ORDER.map((name) => {
            const tab = TABS[name];
            const hidden =
              (name === "record-media-output" &&
                (IS_PROMO || Platform.OS === "ios")) ||
              (name === "expo-alternatives" && IS_PROMO);

            return (
              <NativeTabs.Trigger
                key={name}
                name={name}
                hidden={hidden}
                disableAutomaticContentInsets
                contentStyle={{ backgroundColor: colors.background }}
                unstable_nativeProps={{
                  style: { backgroundColor: colors.background },
                }}
              >
                <NativeTabs.Trigger.Label>{tab.label}</NativeTabs.Trigger.Label>
                <NativeTabs.Trigger.Icon sf={tab.sf} md={tab.md} />
              </NativeTabs.Trigger>
            );
          })}
        </NativeTabs>
      </PromoOrbProvider>
    </ThemeProvider>
  );
}

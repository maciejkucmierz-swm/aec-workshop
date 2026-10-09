import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { useColorScheme } from "react-native";

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
      {/* Screens render static views, which would otherwise make the tab bar transparent on iOS 18 and earlier. */}
      <NativeTabs disableTransparentOnScrollEdge>
        <NativeTabs.Trigger name="index">
          <NativeTabs.Trigger.Label>Patched</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "mic", selected: "mic.fill" }}
            md={{ default: "mic_none", selected: "mic" }}
          />
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="record-unpatched">
          <NativeTabs.Trigger.Label>Upstream</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "mic.slash", selected: "mic.slash.fill" }}
            md={{ default: "mic_off", selected: "mic_off" }}
          />
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="record-media-output">
          <NativeTabs.Trigger.Label>Media</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "speaker.wave.2", selected: "speaker.wave.2.fill" }}
            md={{ default: "volume_up", selected: "volume_up" }}
          />
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="expo-alternatives">
          <NativeTabs.Trigger.Label>Expo</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "waveform.path.ecg", selected: "waveform.path.ecg" }}
            md={{ default: "science", selected: "science" }}
          />
        </NativeTabs.Trigger>

        <NativeTabs.Trigger name="expo-duplex">
          <NativeTabs.Trigger.Label>Duplex</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: "waveform", selected: "waveform" }}
            md={{ default: "graphic_eq", selected: "graphic_eq" }}
          />
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}

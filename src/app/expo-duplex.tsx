import { Platform, View } from "react-native";

import { ExpoVoiceAgent } from "@/components/expo-audio/voice-agent";
import { WorkshopHeading, WorkshopSurface, workshopStyles } from "@/lib/workshop-ui";

export default function ExpoDuplexScreen() {
  return (
    <WorkshopSurface>
      <View style={workshopStyles.content}>
        {Platform.OS !== "android" ? (
          <WorkshopHeading
            title="Stock Expo Audio full duplex"
            description="This loudspeaker experiment targets Android first. iOS and web execution are deferred."
          />
        ) : (
          <ExpoVoiceAgent mode="full-duplex" />
        )}
      </View>
    </WorkshopSurface>
  );
}

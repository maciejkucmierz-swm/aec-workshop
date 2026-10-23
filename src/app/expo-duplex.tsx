import { Platform, View } from "react-native";

import { ExpoVoiceAgent } from "@/components/expo-audio/voice-agent";
import { WorkshopHeading, WorkshopSurface, useWorkshopStyles } from "@/lib/workshop-ui";

export default function ExpoDuplexScreen() {
  const workshopStyles = useWorkshopStyles();
  return (
    <WorkshopSurface>
      <View style={workshopStyles.content}>
        {Platform.OS === "web" ? (
          <WorkshopHeading
            title="Stock Expo Audio full duplex"
            description="This stock Expo Audio experiment targets Android and iPhone. Web execution is deferred."
          />
        ) : (
          <ExpoVoiceAgent mode="full-duplex" />
        )}
      </View>
    </WorkshopSurface>
  );
}

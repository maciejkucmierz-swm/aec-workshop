import { VoiceScreen } from "./record";

/**
 * Keeps the microphone on the communication-input profile but opens assistant
 * playback with react-native-audio-api's upstream media output attributes.
 * This is an Android volume/routing comparison, not an AEC configuration.
 */
export default function MediaOutputVoiceScreen() {
  return (
    <VoiceScreen
      audioStreamProfile="media-output"
      implementationName="Media-output voice"
      implementationDescription="Communication mic with assistant audio on Android's media stream."
    />
  );
}

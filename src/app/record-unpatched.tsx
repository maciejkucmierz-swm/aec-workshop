import { VoiceScreen } from "./record";

/**
 * Same React UI, routing, network protocol and session configuration as the
 * patched tab. The only intentional difference is that the native audio API
 * opens streams using react-native-audio-api's upstream defaults.
 */
export default function UpstreamAudioApiVoiceScreen() {
  return (
    <VoiceScreen
      audioStreamProfile="upstream-defaults"
      implementationName="Upstream audio API defaults"
      implementationDescription="Same call setup, without this app's custom audio-stream patch."
    />
  );
}

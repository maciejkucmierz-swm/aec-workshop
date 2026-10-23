import { VoiceScreen } from "./record";

/**
 * Same session and UI as the voice-processing tab, but raw/default capture and
 * media output. Both comparisons use the same unmodified upstream package.
 */
export default function UpstreamAudioApiVoiceScreen() {
  return (
    <VoiceScreen
      audioStreamProfile="upstream-defaults"
      implementationName="Upstream audio API defaults"
      implementationDescription="Same call setup, with default capture processing and media output."
    />
  );
}

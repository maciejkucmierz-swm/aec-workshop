/**
 * react-native-audio-api builds its Android Oboe streams with the library's
 * own hardcoded attributes and exposes no JS option for them. Oboe's defaults
 * are Usage::Media for output and InputPreset::VoiceRecognition for input,
 * which puts playback on the media stream and asks for capture with no voice
 * processing, so the platform echo canceller never sees either side of the
 * conversation. Reconfiguring that means patching the package.
 *
 * patch-package is not usable here: it requires an npm or yarn lockfile. And
 * `bun patch` deletes node_modules/react-native-audio-api in this project
 * ("error overwriting folder in node_modules: FileNotFound"), so the diff is
 * applied directly instead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const AUDIO_API_VERSION = "0.13.3";
const AUDIO_API_TARGET = "node_modules/react-native-audio-api";

const PATCHES = [
  {
    patch: "patches/react-native-audio-api+0.13.3.patch",
    target: "node_modules/react-native-audio-api",
    // The iOS lifecycle migration moves the voice-processing call, so use the
    // Android communication-input marker which remains stable across both patches.
    marker: "InputPreset::VoiceCommunication",
    markerFile: "android/src/main/cpp/audioapi/android/core/AndroidAudioRecorder.cpp",
  },
  // This migration adds a runtime selector so the patched and upstream stream
  // profiles can be compared inside one development build.
  {
    patch: "patches/react-native-audio-api-comparison-profile+0.13.3.patch",
    target: "node_modules/react-native-audio-api",
    marker: "setAudioApiVoiceProcessingProfile",
    markerFile: "common/cpp/audioapi/AudioAPIModuleInstaller.h",
  },
  {
    patch: "patches/react-native-audio-api-media-output-profile+0.13.3.patch",
    target: "node_modules/react-native-audio-api",
    marker: "MediaOutput = 2",
    markerFile: "common/cpp/audioapi/core/utils/VoiceProcessingProfile.h",
  },
  // Voice Processing I/O must be selected after iOS activates the session and
  // before the engine starts; doing it while the old session is inactive can
  // create a graph with stale hardware formats on current iOS releases.
  {
    patch: "patches/react-native-audio-api-ios-voice-processing-lifecycle+0.13.3.patch",
    target: "node_modules/react-native-audio-api",
    marker: "Voice processing changes AVAudioEngine's I/O units",
    markerFile: "ios/audioapi/ios/system/AudioEngine.mm",
  },
  {
    patch: "patches/react-native-audio-api-android-communication-session+0.13.3.patch",
    target: "node_modules/react-native-audio-api",
    marker: "activateCommunicationSession",
    markerFile: "android/src/main/java/com/swmansion/audioapi/system/MediaSessionManager.kt",
  },
  // Incremental: the communication-session patch above originally shipped iOS stubs.
  {
    patch: "patches/react-native-audio-api-ios-communication-routing+0.13.3.patch",
    target: "node_modules/react-native-audio-api",
    marker: "AEC workshop iOS communication routing",
    markerFile: "ios/audioapi/ios/AudioAPIModule.mm",
  },
];

const packageJson = path.join(AUDIO_API_TARGET, "package.json");
if (!existsSync(packageJson)) {
  throw new Error(
    `Missing ${AUDIO_API_TARGET}. Run bun install from the repository root.`,
  );
}

const installedVersion = JSON.parse(readFileSync(packageJson, "utf8")).version;
if (installedVersion !== AUDIO_API_VERSION) {
  throw new Error(
    `Expected react-native-audio-api@${AUDIO_API_VERSION}, found ${installedVersion}. Update the patches before changing this dependency.`,
  );
}

if (spawnSync("patch", ["--version"], { stdio: "ignore" }).status !== 0) {
  throw new Error("The system patch command is required to apply RNAA patches.");
}

for (const { patch, target, marker, markerFile } of PATCHES) {
  const markedFile = path.join(target, markerFile);

  if (!existsSync(patch)) {
    throw new Error(`Missing native patch: ${patch}`);
  }

  if (!existsSync(markedFile)) {
    throw new Error(`Patch target is missing: ${markedFile}`);
  }

  if (readFileSync(markedFile, "utf8").includes(marker)) {
    console.log(`${patch} already applied`);
    continue;
  }

  execFileSync("patch", ["--batch", "--forward", "-p1", "-d", target, "-i", path.resolve(patch)], {
    stdio: "inherit",
  });

  if (!readFileSync(markedFile, "utf8").includes(marker)) {
    throw new Error(`Patch did not apply its expected marker: ${patch}`);
  }
  console.log(`applied ${patch}`);
}

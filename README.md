# Full-duplex voice agent audio workshop

An Expo SDK 57 / React Native 0.86 workshop for comparing voice-agent audio paths on physical devices. It streams 24 kHz PCM16 microphone audio to a local relay and plays streamed assistant audio.

## What it compares

- **Patched** — RNAA communication capture and voice output, including the platform voice-processing path where available.
- **Upstream** — the same RNAA app flow with upstream stream defaults.
- **Media** (Android only) — communication capture with media-style assistant output.
- **Expo** — stock Expo Audio half duplex. Android also offers a `mic` versus `voice_communication` recorder diagnostic.
- **Duplex** — stock Expo Audio microphone streaming throughout progressive AAC assistant playback, with spoken interruption and live diagnostics. Implemented on Android and iPhone; iPhone simultaneous capture/playback remains a device-unverified experiment.

Android shows all five tabs; iOS shows Patched, Upstream, Expo, and Duplex. The two RNAA voice tabs retain their processing distinction on iOS. Phone/Speaker selection uses the actual built-in receiver/loudspeaker route, restored after a resumable interruption. The Media profile and recorder-source diagnostic are Android-specific and hidden on iOS.

Results are device-specific evidence, not a guarantee of AEC performance across routes, volumes, rooms, or devices.

### Full-duplex comparison on Android

Keep loudspeaker volume, phone position, network, and prompt fixed. Run three trials each in Patched, Expo (half duplex), and Duplex:

1. Ask the assistant to count slowly to twenty, then stay silent. Note whether its speech appears as a **You** transcript or causes an interruption.
2. Interrupt with a different question while it speaks. Repeat late in the reply, when generation may have finished but playback is still buffered. Listen for a prompt stop and any stale replay.
3. In Duplex, check that **Buffers sent during playback** and **Relay received** increase together while the assistant is audible. The former counts buffers sent during observed playback; the latter counts all microphone buffers accepted by the relay for this connection.
4. Disconnect/reconnect and change tabs during a reply. Capture and playback should stop when leaving. Half duplex should pause capture for every reply; its playback buffer count should remain zero.

Playback replacement, observed start, completion, and interruption timestamps appear in Metro and relay logs. Player timing is approximate and does not measure acoustic output. Record actual observations; a VAD interruption alone does not prove echo, and this experiment does not establish universal Expo AEC support or failure. Web execution of Duplex is deferred.

### iPhone validation (user-run)

Use a physical iPhone in the foreground with its built-in microphone/receiver/loudspeaker. Headsets, Bluetooth, iPad routing, and background operation are not acceptance targets. Build success is not acoustic validation.

1. Grant microphone and local-network access. Start the local relay, confirm the LAN address, and connect in each of the four tabs. If permission was denied, enable it in iOS Settings before retrying.
2. With fixed phone position, network, prompt, and loudspeaker volume, run three trials each in Patched, Upstream, Expo half duplex, and Duplex. Record audible output, transcripts, echo/self-transcription, false interruptions, and response delay.
3. In both RNAA tabs, switch Phone/Speaker during a call and verify the **actual audible** receiver/loudspeaker output. Try a system interruption, then return and confirm the selected route/capture recover when iOS permits resumption.
4. In Expo half duplex, verify the mic pauses before every reply and resumes only after playback finishes. No barge-in is supported.
5. In Duplex, confirm audible assistant playback **and** increasing sent-during-playback/relay-received counts. Test spoken interruption during generation and late buffered playback; there must be no stale replay. Silence during assistant-only speech and note any self-transcription or false interruptions.
6. Disconnect during setup, reconnect immediately, and switch tabs during playback. The old mic/playback must stop before the next tab activates.

Expo remains entirely stock: half duplex switches to playback-only after mic cleanup, then back to recording when listening. Duplex reapplies recording-enabled speaker mode after microphone startup because SDK 57's iOS stream selects recording-only mode. The documented [`keepAudioSessionActive` player option](https://docs.expo.dev/versions/v57.0.0/sdk/audio/#audioplayeroptions) prevents pause/completion from deactivating the microphone's session; disconnect explicitly releases it through the shared lifecycle queue. This public-API sequence may itself interrupt capture; three seconds without microphone buffers ends the session with an explicit capture error, not a silent half-duplex/native-AEC fallback. Report that limitation if encountered.

## Prerequisites

- macOS or Linux with [Bun](https://bun.sh/), Git, and the system `patch` command.
- [ffmpeg](https://ffmpeg.org/) on your `PATH` for the local relay and Expo Audio diagnostic.
- Android Studio and an Android SDK for Android builds. Xcode is additionally required for iOS builds.
- A physical device on the same LAN as this computer for voice testing.

Expo Go is not supported. This workshop uses native RNAA code and requires a development or release build.

## Setup

```bash
bun install
cp .env.example .env.local
```

Set `OPENAI_API_KEY` in `.env.local`. The key is used only by `server/index.mjs`; do not commit it or expose it through an `EXPO_PUBLIC_` variable.

Run the local relay and Metro in separate terminals:

```bash
bun run token-server
```

Restart this process after relay code changes. Metro refreshes the app, not the relay. The Expo agent accepts older audio messages too, but relay buffer counts require the updated relay; `--` means no count has been received.

```bash
bun run start
```

Build and install a native development client when first setting up, or after native dependency/config changes:

```bash
bun run android
# or, on macOS with Xcode:
bun run ios
```

For a physical device, Metro normally supplies the computer's LAN host automatically. If it does not, set `EXPO_PUBLIC_TOKEN_URL=http://YOUR_LAN_IP:8787` in `.env.local` and restart Metro. iOS requests local-network access; its configuration permits local networking without a global arbitrary-network exception.

## Native patches

The RNAA comparison tabs rely on the version-pinned patches in `patches/`. `bun install` applies them automatically to `react-native-audio-api@0.13.3`. No patched `node_modules` files or generated `android`/`ios` directories are committed; a clean install reproduces the native setup.

After pulling patch or native configuration changes, run `bun install` and rebuild the development client (including regenerating an existing native project with `bunx expo prebuild --platform ios` on macOS). The incremental iOS routing patch has its own installer marker, so previously patched dependencies receive it too. Metro refresh alone cannot load native changes.

## Checks

```bash
bun run check
```

# Full-duplex voice agent audio workshop

An Expo SDK 57 / React Native 0.86 workshop for comparing voice-agent audio paths on physical devices. It streams 24 kHz PCM16 microphone audio to a local relay and plays streamed assistant audio.

## What it compares

- **Patched Voice** — RNAA communication capture and voice output, including the platform voice-processing path where available.
- **Upstream Voice** — the same RNAA app flow with upstream stream defaults.
- **Media Voice** — communication capture with Android media-style assistant output.
- **Expo Audio** — stock Expo Audio half duplex and an Android `mic` versus `voice_communication` recorder diagnostic.

Results are device-specific evidence, not a guarantee of AEC performance across routes, volumes, rooms, or devices.

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

```bash
bun run start
```

Build and install a native development client when first setting up, or after native dependency/config changes:

```bash
bun run android
# or, on macOS with Xcode:
bun run ios
```

For a physical device, Metro normally supplies the computer's LAN host automatically. If it does not, set `EXPO_PUBLIC_TOKEN_URL=http://YOUR_LAN_IP:8787` in `.env.local` and restart Metro.

## Native patches

The RNAA comparison tabs rely on the version-pinned patches in `patches/`. `bun install` applies them automatically to `react-native-audio-api@0.13.3`. No patched `node_modules` files or generated `android`/`ios` directories are committed; a clean install reproduces the native setup.

## Checks

```bash
bun run check
```

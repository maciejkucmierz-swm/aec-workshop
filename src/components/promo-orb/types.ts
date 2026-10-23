import type { AppAppearance } from "@/lib/theme";

export type PromoOrbState =
  | "idle" | "listening" | "speaking"
  | "paused" | "disconnecting" | "error";
export type PromoOrbProps = {
  state?: PromoOrbState;
  size: number;
  containerHeight?: number;
  hearing?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  disabled: boolean;
};

export type OrbPalette = {
  primary: [number, number, number];
  accent: [number, number, number];
  highlight: [number, number, number];
};

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

// Convert once at module load, never in the frame loop.
function palette(primary: string, accent: string, highlight: string): OrbPalette {
  return { primary: rgb(primary), accent: rgb(accent), highlight: rgb(highlight) };
}

export const ORB_PALETTES: Record<AppAppearance, Record<PromoOrbState, OrbPalette>> = {
  light: {
    idle: palette("#8A8F98", "#A6ADB5", "#D6DADF"),
    listening: palette("#147D92", "#4E8EC3", "#A0D8C7"),
    speaking: palette("#7654AC", "#AB6E9E", "#D7B5E3"),
    paused: palette("#61758B", "#8798AA", "#C0CBD5"),
    disconnecting: palette("#A97968", "#C49B86", "#E2C4B2"),
    error: palette("#B1495E", "#CD7481", "#EDB8B5"),
  },
  dark: {
    idle: palette("#68717F", "#8893A2", "#C7D0DB"),
    listening: palette("#46B5C3", "#6A9FD8", "#B6E9D5"),
    speaking: palette("#A58AD9", "#D197C3", "#E4D1F3"),
    paused: palette("#7F94AD", "#A2B2C7", "#D0DBE8"),
    disconnecting: palette("#BA9181", "#D1AE98", "#EAD3C1"),
    error: palette("#D66F80", "#E79AA5", "#F2C5C1"),
  },
};

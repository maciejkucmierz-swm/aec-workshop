import { useColorScheme } from "react-native";

export type AppAppearance = "light" | "dark";

// Porcelain and Midnight: shared by workshop, promo, and native navigation.
export const APP_PALETTE = {
  light: {
    background: "#F7F5F1",
    panel: "#FFFDFA",
    field: "#FFFDFA",
    text: "#25272D",
    muted: "#686D77",
    placeholder: "#686D77",
    border: "#DEDCD7",
    accent: "#147D92",
    accentText: "#FFFDFA",
    selection: "#DDECEB",
    button: "#25272D",
    buttonText: "#FFFDFA",
    endButton: "#F3E2E3",
    endText: "#8B3448",
    error: "#A33F54",
    warning: "#94601F",
    status: {
      idle: "#8A8F98",
      connecting: "#B78136",
      connected: "#147D92",
      assistant: "#7654AC",
      disconnecting: "#A97968",
      error: "#B1495E",
    },
  },
  dark: {
    background: "#101217",
    panel: "#1A1D24",
    field: "#1A1D24",
    text: "#F2F0EB",
    muted: "#A3A7B2",
    placeholder: "#A3A7B2",
    border: "#2C3039",
    accent: "#46B5C3",
    accentText: "#101217",
    selection: "#253B40",
    button: "#F2F0EB",
    buttonText: "#101217",
    endButton: "#402830",
    endText: "#F2C5C1",
    error: "#E79AA5",
    warning: "#DDB66B",
    status: {
      idle: "#8893A2",
      connecting: "#DDB66B",
      connected: "#46B5C3",
      assistant: "#A58AD9",
      disconnecting: "#D1AE98",
      error: "#D66F80",
    },
  },
};

export type AppColors = typeof APP_PALETTE.light;

export function useAppAppearance(): AppAppearance {
  return useColorScheme() === "dark" ? "dark" : "light";
}

export function useAppColors(): AppColors {
  return APP_PALETTE[useAppAppearance()];
}

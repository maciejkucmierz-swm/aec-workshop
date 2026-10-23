import {
  Root,
  useConfigureContext,
  useFrame,
  useRoot,
  useRootWithStatus,
  useUniform,
} from "@typegpu/react";
import { useIsFocused } from "expo-router";
import {
  Component,
  createContext,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  AppState,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Canvas, type CanvasRef } from "react-native-webgpu";
import Animated from "react-native-reanimated";

import { IS_PROMO } from "@/lib/app-mode";
import { PROMO_LAYOUT, promoStyles, usePromoColors } from "@/lib/promo-ui";
import { useAppAppearance } from "@/lib/theme";
import { OrbParams, orbFragment, orbParams, orbVertex } from "./promo-orb/shader";
import { ORB_PALETTES, type OrbPalette, type PromoOrbProps, type PromoOrbState } from "./promo-orb/types";
import { useOrbTapAnimation } from "./promo-orb/use-tap-animation";

type OrbPlacement = { x: number; y: number; size: number };
type OrbRegistration = PromoOrbProps & OrbPlacement & { owner: symbol };
const OrbHostContext = createContext<{
  show: (owner: symbol, props: PromoOrbProps & OrbPlacement) => void;
  release: (owner: symbol) => void;
} | null>(null);

export function PromoOrbProvider({ children }: { children: ReactNode }) {
  return IS_PROMO ? (
    <Root disableWorklets>
      <PersistentOrbHost>{children}</PersistentOrbHost>
    </Root>
  ) : children;
}

function PersistentOrbHost({ children }: { children: ReactNode }) {
  const { animatedStyle, pulse } = useOrbTapAnimation();
  const hostRef = useRef<View>(null);
  const ownerRef = useRef<symbol | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const [orb, setOrb] = useState<OrbRegistration | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [reduceMotion, setReduceMotion] = useState(true);
  const show = useCallback((owner: symbol, props: PromoOrbProps & OrbPlacement) => {
    ownerRef.current = owner;
    setOrb({ ...props, owner });
  }, []);
  const release = useCallback((owner: symbol) => {
    if (ownerRef.current !== owner) return;
    ownerRef.current = null;
    // Keep the last frame and canvas mounted while the next tab takes ownership.
    setOrb((current) => current ? { ...current, state: "idle", hearing: false, disabled: true } : null);
  }, []);
  const host = useMemo(() => ({ show, release }), [show, release]);

  useEffect(() => {
    let mounted = true;
    const appSubscription = AppState.addEventListener("change", (state) => {
      setForeground(state === "active");
    });
    const motionSubscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduceMotion,
    );
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => { /* Keep the orb stationary if the preference is unavailable. */ });
    return () => {
      mounted = false;
      appSubscription.remove();
      motionSubscription.remove();
    };
  }, []);

  return (
    <OrbHostContext.Provider value={host}>
      <View
        ref={hostRef}
        collapsable={false}
        style={styles.host}
        onLayout={() => hostRef.current?.measureInWindow((x, y) => setOrigin({ x, y }))}
      >
        {children}
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
          {orb ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={orb.accessibilityLabel}
              accessibilityHint="Starts, cancels, or ends this tab's conversation."
              accessibilityState={{ disabled: orb.disabled || !foreground }}
              accessibilityLiveRegion="polite"
              disabled={orb.disabled || !foreground}
              onPress={() => {
                if (!orb.disabled && foreground && ownerRef.current === orb.owner) {
                  pulse();
                  orb.onPress();
                }
              }}
              style={[
                styles.control,
                {
                  left: orb.x - (origin?.x ?? 0), top: orb.y - (origin?.y ?? 0),
                  width: orb.size, height: orb.size, opacity: origin ? 1 : 0,
                },
              ]}
            >
              <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, animatedStyle]}>
                <View
                  pointerEvents="none"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={[
                    styles.canvas,
                    {
                      left: (orb.size - PROMO_LAYOUT.maxOrbSize) / 2,
                      top: (orb.size - PROMO_LAYOUT.maxOrbSize) / 2,
                      transform: [{ scale: orb.size / PROMO_LAYOUT.maxOrbSize }],
                    },
                  ]}
                >
                  <OrbBoundary>
                    <ReadyOrb
                      state={orb.state ?? "idle"}
                      hearing={orb.hearing ?? false}
                      reduceMotion={reduceMotion}
                      foreground={foreground}
                    />
                  </OrbBoundary>
                </View>
              </Animated.View>
            </Pressable>
          ) : null}
        </View>
      </View>
    </OrbHostContext.Provider>
  );
}

/** Each screen reserves layout space; only the navigation-level host renders a canvas. */
export function PromoOrb({ state = "idle", size, containerHeight, hearing = false, onPress, accessibilityLabel, disabled }: PromoOrbProps) {
  const host = useContext(OrbHostContext)!;
  const focused = useIsFocused();
  const [owner] = useState(() => Symbol("promo-orb"));
  const slotRef = useRef<View>(null);
  const frameRef = useRef<OrbPlacement | null>(null);
  const measurementRef = useRef(0);
  const focusedRef = useRef(false);
  const propsRef = useRef({ state, hearing, onPress, accessibilityLabel, disabled });
  const publish = useCallback(() => {
    if (focusedRef.current && frameRef.current) {
      host.show(owner, { ...propsRef.current, ...frameRef.current });
    }
  }, [host, owner]);
  const measure = useCallback(() => {
    const measurement = ++measurementRef.current;
    slotRef.current?.measureInWindow((x, y, width, height) => {
      if (!focusedRef.current || measurement !== measurementRef.current || width <= 0 || height <= 0) return;
      frameRef.current = { x, y, size: Math.min(width, height) };
      publish();
    });
  }, [publish]);

  useLayoutEffect(() => {
    propsRef.current = { state, hearing, onPress, accessibilityLabel, disabled };
    publish();
  }, [state, hearing, onPress, accessibilityLabel, disabled, publish]);
  useLayoutEffect(() => {
    focusedRef.current = focused;
    if (focused) {
      publish();
    }
    return () => {
      focusedRef.current = false;
      host.release(owner);
    };
  }, [focused, host, owner, publish]);
  useLayoutEffect(() => {
    // Safe-area/tab insets can move the slot without changing its own dimensions.
    if (focused) measure();
  }, [focused, size, containerHeight, measure]);

  return (
    <View
      ref={slotRef}
      collapsable={false}
      onLayout={measure}
      style={[styles.slot, { width: size, height: size }]}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

function UnavailableOrb() {
  const colors = usePromoColors();
  return (
    <View style={styles.unavailable}>
      <Text style={[promoStyles.detail, { color: colors.muted }]}>
        Animation unavailable
      </Text>
    </View>
  );
}

class OrbBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <UnavailableOrb /> : this.props.children;
  }
}

type OrbAppearanceProps = {
  state: PromoOrbState;
  hearing: boolean;
  reduceMotion: boolean;
  foreground: boolean;
};
// Canvas refreshes its native ref handle on render. Keep state updates out of it.
const OrbSurface = memo(Canvas);
const ORB_RENDER_SCALE = 1.5;

function ReadyOrb(props: OrbAppearanceProps) {
  const root = useRootWithStatus();
  const [failed, setFailed] = useState(false);
  const onFailure = useCallback(() => setFailed(true), []);

  if (failed || root.status === "rejected") return <UnavailableOrb />;
  if (root.status === "pending") return null; // The slot reserves its full size during loading.

  return <OrbCanvas {...props} onFailure={onFailure} />;
}

function OrbCanvas({ state, hearing, reduceMotion, foreground, onFailure }: OrbAppearanceProps & {
  onFailure: () => void;
}) {
  const palette = ORB_PALETTES[useAppAppearance()][state];
  const root = useRoot();
  const params = useUniform(OrbParams);
  const { ref, ctxRef } = useConfigureContext({ alphaMode: "premultiplied", autoResize: false });
  const renderSize = Math.round(PROMO_LAYOUT.maxOrbSize * PixelRatio.get() * ORB_RENDER_SCALE);
  // The hook's React Effect Event ref changes identity; don't reattach the native surface.
  const configureRef = useRef(ref);
  useLayoutEffect(() => { configureRef.current = ref; }, [ref]);
  const attachCanvas = useCallback((canvas: CanvasRef | null) => configureRef.current(canvas), []);
  const pipeline = useMemo(
    () => root.with(orbParams, params).createRenderPipeline({
      vertex: orbVertex,
      fragment: orbFragment,
      targets: { format: navigator.gpu.getPreferredCanvasFormat() },
    }),
    [root, params],
  );
  const [initialized, setInitialized] = useState(false);
  const [stationaryPalette, setStationaryPalette] = useState<OrbPalette | null>(null);
  const appearance = useRef<OrbAppearance>({
    time: 0, listening: 0, speaking: 0,
    primary: [...palette.primary],
    accent: [...palette.accent],
    highlight: [...palette.highlight],
  });

  useEffect(() => {
    let mounted = true;
    void pipeline.initAsync()
      .then(() => { if (mounted) setInitialized(true); })
      .catch(() => { if (mounted) onFailure(); });
    return () => { mounted = false; };
  }, [pipeline, onFailure]);

  return (
    <>
      <OrbSurface
        ref={attachCanvas}
        opaque={false}
        style={StyleSheet.absoluteFill}
      />
      {initialized && foreground && (!reduceMotion || stationaryPalette !== palette) && (
        <OrbFrames
          appearanceRef={appearance}
          state={state}
          hearing={hearing}
          palette={palette}
          stationary={reduceMotion}
          render={(appearance) => {
            const ctx = ctxRef.current;
            if (!ctx) return false;
            // Supersample the drawing buffer without resizing/remounting the native view.
            const canvas = ctx.canvas;
            if (canvas.width !== renderSize || canvas.height !== renderSize) {
              canvas.width = renderSize;
              canvas.height = renderSize;
            }
            params.write(appearance);
            pipeline.withColorAttachment({
              view: ctx.getCurrentTexture().createView(),
              clearValue: [0, 0, 0, 0],
              loadOp: "clear",
              storeOp: "store",
            }).draw(3);
            ctx.present?.();
            if (reduceMotion) setStationaryPalette(palette);
            return true;
          }}
          onFailure={onFailure}
        />
      )}
    </>
  );
}

// Unmounting this small child cancels useFrame's RAF, including after a stationary draw.
type OrbAppearance = OrbPalette & { time: number; listening: number; speaking: number };
const PALETTE_CHANNELS = ["primary", "accent", "highlight"] as const;

function OrbFrames({ appearanceRef, state, hearing, palette, stationary, render, onFailure }: {
  appearanceRef: RefObject<OrbAppearance>;
  state: PromoOrbState;
  hearing: boolean;
  palette: OrbPalette;
  stationary: boolean;
  render: (appearance: OrbAppearance) => boolean;
  onFailure: () => void;
}) {
  const failed = useRef(false);
  useFrame(({ deltaSeconds }) => {
    if (failed.current) return;
    try {
      const current = appearanceRef.current;
      const delta = Math.min(0.05, Math.max(0, deltaSeconds));
      const blend = stationary ? 1 : 1 - Math.exp(-delta / 0.18);
      // Listening colors stay on while the mic is open; motion needs detected speech.
      const hearingSpeech = !stationary && state === "listening" && hearing;
      current.listening += ((hearingSpeech ? 1 : 0) - current.listening) * blend;
      current.speaking += ((state === "speaking" ? 1 : 0) - current.speaking) * blend;
      for (const key of PALETTE_CHANNELS) {
        for (let index = 0; index < 3; index += 1) {
          current[key][index] = stationary ? palette[key][index]
            : current[key][index] + (palette[key][index] - current[key][index]) * blend;
        }
      }
      if (render(current) && !stationary) {
        current.time = (current.time + delta *
          (0.75 + current.listening * 0.45 + current.speaking * 1.8)) % 900;
      }
    } catch {
      failed.current = true;
      onFailure();
    }
  });
  return null;
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  control: { position: "absolute", borderRadius: 999 },
  // Fixed native dimensions avoid reconfiguring the surface when a slot is resized.
  canvas: { position: "absolute", width: PROMO_LAYOUT.maxOrbSize, height: PROMO_LAYOUT.maxOrbSize },
  slot: { alignSelf: "center", flexShrink: 0 },
  unavailable: { flex: 1, alignItems: "center", justifyContent: "center" },
});

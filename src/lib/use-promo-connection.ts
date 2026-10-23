import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect, useIsFocused } from "expo-router";

import { IS_PROMO } from "@/lib/app-mode";
import type { PromoConnectionState } from "@/lib/promo-ui";

type PromoConnectionOptions = {
  status: PromoConnectionState;
  microphoneActive: boolean;
  connect: () => void | Promise<void>;
  disconnect: () => void | Promise<void>;
  startMic: () => void | Promise<void>;
};

/** A warm transport is not permission to capture: only an explicit tap starts audio. */
export function usePromoConnection(options: PromoConnectionOptions) {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [requested, setRequested] = useState(false);
  const requestedRef = useRef(false);
  const micStartRequestedRef = useRef(false);
  const actions = useRef(options);
  useLayoutEffect(() => { actions.current = options; }, [options]);
  const available = focused && foreground;

  useEffect(() => {
    if (!IS_PROMO) return;
    const subscription = AppState.addEventListener("change", (state) => {
      // Permission dialogs temporarily make iOS inactive; they are not a tab exit.
      if (state === "background") setForeground(false);
      else if (state === "active") setForeground(true);
    });
    return () => subscription.remove();
  }, []);

  useFocusEffect(useCallback(() => {
    if (!IS_PROMO || !foreground) return;
    void actions.current.connect();
    return () => {
      requestedRef.current = false;
      micStartRequestedRef.current = false;
      setRequested(false);
      void actions.current.disconnect();
    };
  }, [foreground]));

  const startRequestedMic = useCallback(() => {
    if (micStartRequestedRef.current || !requestedRef.current || actions.current.status !== "connected") return;
    micStartRequestedRef.current = true;
    void actions.current.startMic();
  }, []);

  useEffect(() => {
    if (!IS_PROMO || !available) return;
    if (options.status === "idle") void actions.current.connect();
    else if (options.status === "connected" && requested) startRequestedMic();
  }, [available, options.status, requested, startRequestedMic]);

  const toggle = useCallback(() => {
    if (!available || actions.current.status === "disconnecting") return;
    if (requestedRef.current && actions.current.status !== "error") {
      requestedRef.current = false;
      micStartRequestedRef.current = false;
      setRequested(false);
      void actions.current.disconnect();
    } else {
      requestedRef.current = true;
      micStartRequestedRef.current = false;
      setRequested(true);
      if (actions.current.status === "error") void actions.current.connect();
      else startRequestedMic();
    }
  }, [available, startRequestedMic]);

  const connection: PromoConnectionState = options.status === "disconnecting" || options.status === "error"
    ? options.status
    : !requested || !available ? "idle"
    : options.status === "connected" && options.microphoneActive ? "connected" : "connecting";
  return { connection, requested, toggle };
}

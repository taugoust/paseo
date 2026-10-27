import { getSpinnerDotOpacity, getSpinnerStep, SPINNER_DOT_COUNT } from "@getpaseo/plugin/shared";

// Keep the app-facing names stable while the worklet-safe implementation lives in the bundled SDK.
export const SYNCED_LOADER_DOT_COUNT = SPINNER_DOT_COUNT;
export const getSyncedLoaderStep = getSpinnerStep;
export const getSyncedLoaderDotOpacity = getSpinnerDotOpacity;

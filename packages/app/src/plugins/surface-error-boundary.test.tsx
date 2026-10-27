/**
 * @vitest-environment jsdom
 */
import React, { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Text } from "react-native";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "expo-router/react-navigation";
import { useIsFocused as useLegacyIsFocused } from "@react-navigation/native";
import { useIsFocused } from "./surface-focus";

// Avoid loading unrelated native screens in Node; keep the real context objects
// and hook implementations from both navigation owners (no focus-hook mocks).
vi.mock("expo-router/react-navigation", async () => ({
  ...(await import("expo-router/build/react-navigation/core/NavigationContext")),
  ...(await import("expo-router/build/react-navigation/core/useIsFocused")),
}));
vi.mock("@react-navigation/native", () => import("@react-navigation/core"));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: (theme: object) => object) =>
      factory({ colors: { statusDanger: "red" }, spacing: [0, 4, 8, 12, 16] }),
  },
}));

let oldSurfaceCleanups = 0;
function FailingSurface() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(true);
    return () => {
      oldSurfaceCleanups += 1;
    };
  }, []);
  if (failed) throw new Error("old render exploded");
  return <Text>Old surface mounted</Text>;
}
function CorrectedSurface() {
  return <Text>Corrected surface</Text>;
}
const oldInstallation = {};
const correctedInstallation = {};

describe("SurfaceErrorBoundary", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLElement[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) act(() => root.unmount());
    for (const container of containers.splice(0)) container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    oldSurfaceCleanups = 0;
  });

  it("renders a plugin surface in Expo's navigation context and follows focus/blur", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    let focused = true;
    const listeners = new Set<() => void>();
    // A real Expo context, not a mocked hook: the host router owns this context,
    // which is distinct from the separately installed React Navigation package.
    const navigation = {
      isFocused: () => focused,
      addListener: (_event: string, listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as NavigationProp<ParamListBase>;
    function LegacySurface() {
      return <Text>{useLegacyIsFocused() ? "focused" : "blurred"}</Text>;
    }
    function FocusedSurface() {
      return <Text>{useIsFocused() ? "focused" : "blurred"}</Text>;
    }
    const draw = (Surface: React.ComponentType) =>
      React.createElement(
        NavigationContext.Provider,
        { value: navigation },
        <SurfaceErrorBoundary installation={oldInstallation} Surface={Surface}>
          <Surface />
        </SurfaceErrorBoundary>,
      );
    await act(async () => root.render(draw(LegacySurface)));
    expect(container.textContent).toContain("Couldn't find a navigation object");
    await act(async () => root.render(draw(FocusedSurface)));
    expect(container.textContent).toBe("focused");
    await act(async () => {
      focused = false;
      for (const listener of listeners) listener();
    });
    expect(container.textContent).toBe("blurred");
    await act(async () => {
      focused = true;
      for (const listener of listeners) listener();
    });
    expect(container.textContent).toBe("focused");
    await act(async () => root.unmount());
    roots.pop();
    expect(listeners.size).toBe(0);
  });

  it("recovers a mounted failed route when its installation and surface are replaced", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const container = document.createElement("div");
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <SurfaceErrorBoundary
          key="host/plugin/surface"
          installation={oldInstallation}
          Surface={FailingSurface}
        >
          <FailingSurface />
        </SurfaceErrorBoundary>,
      );
    });
    expect(container.textContent).toBe("Plugin failed: old render exploded");
    expect(oldSurfaceCleanups).toBe(1);

    await act(async () => {
      root.render(
        <SurfaceErrorBoundary
          key="host/plugin/surface"
          installation={correctedInstallation}
          Surface={CorrectedSurface}
        >
          <CorrectedSurface />
        </SurfaceErrorBoundary>,
      );
    });

    expect(container.textContent).toBe("Corrected surface");
    expect(oldSurfaceCleanups).toBe(1);
  });
});

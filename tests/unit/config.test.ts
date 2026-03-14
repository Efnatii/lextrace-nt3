import { describe, expect, it } from "vitest";

import {
  buildEffectiveConfig,
  defaultConfig,
  mergeConfig,
  mergeConfigPatch,
  normalizeConfigPatch
} from "../../extension/src/shared/config";

describe("config merge", () => {
  it("merges nested overlay and reconnect settings without dropping defaults", () => {
    const merged = mergeConfig(defaultConfig, {
      ui: {
        overlay: {
          width: 1200
        }
      },
      runtime: {
        reconnectPolicy: {
          maxAttempts: 9
        }
      }
    });

    expect(merged.ui.overlay.width).toBe(1200);
    expect(merged.ui.overlay.height).toBe(defaultConfig.ui.overlay.height);
    expect(merged.runtime.reconnectPolicy.maxAttempts).toBe(9);
    expect(merged.runtime.reconnectPolicy.baseDelayMs).toBe(
      defaultConfig.runtime.reconnectPolicy.baseDelayMs
    );
  });

  it("builds effective config from local and session patches", () => {
    const effective = buildEffectiveConfig(
      {
        logging: {
          maxEntries: 800
        }
      },
      {
        ui: {
          popupActiveTab: "config"
        }
      }
    );

    expect(effective.logging.maxEntries).toBe(800);
    expect(effective.ui.popupActiveTab).toBe("config");
    expect(effective.runtime.nativeHostName).toBe(defaultConfig.runtime.nativeHostName);
  });

  it("ignores legacy overlay activeTab patches during normalization", () => {
    const normalized = normalizeConfigPatch({
      ui: {
        overlay: {
          activeTab: "log",
          width: 1111
        }
      }
    });

    const effective = buildEffectiveConfig(normalized, null);

    expect("activeTab" in effective.ui.overlay).toBe(false);
    expect(effective.ui.overlay.width).toBe(1111);
  });

  it("deep-merges nested config patches without dropping sibling ui state", () => {
    const mergedPatch = mergeConfigPatch(
      {
        ui: {
          popupActiveTab: "config"
        }
      },
      {
        ui: {
          overlay: {
            visible: true
          }
        }
      }
    );

    expect(mergedPatch.ui?.popupActiveTab).toBe("config");
    expect(mergedPatch.ui?.overlay?.visible).toBe(true);
  });

  it("ignores legacy protocol.supportedVersion patches during normalization", () => {
    const normalized = normalizeConfigPatch({
      protocol: {
        supportedVersion: 99,
        testCommandsEnabled: false
      }
    });

    const effective = buildEffectiveConfig(null, normalized);

    expect("supportedVersion" in effective.protocol).toBe(false);
    expect(effective.protocol.testCommandsEnabled).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { SpaceMemoryConfig } from "@rakazo/contracts";

vi.mock("./NativeSettingsForm", () => ({ NativeSettingsForm: () => null }));
vi.mock("./HonchoSettingsForm", () => ({ HonchoSettingsForm: () => null }));
vi.mock("./SerenitySettingsForm", () => ({ SerenitySettingsForm: () => null }));
vi.mock("./SupermemorySettingsForm", () => ({ SupermemorySettingsForm: () => null }));
import {
  defaultMemoryProviderSettings,
  MEMORY_PROVIDER_SETTINGS,
  memoryProviderSettings,
} from "./registry";

function config(provider: string, settings: Record<string, string>): SpaceMemoryConfig {
  return {
    provider,
    settings,
    defaultMemoryScope: "isolated",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("memory provider registry", () => {
  it("offers the built-in provider first, so a fresh Space sees it by default", () => {
    expect(MEMORY_PROVIDER_SETTINGS[0]?.id).toBe("native");
    expect(defaultMemoryProviderSettings().id).toBe("native");
  });

  it("keeps every provider id unique", () => {
    const ids = MEMORY_PROVIDER_SETTINGS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("labels the built-in provider without naming a service the user runs", () => {
    const native = memoryProviderSettings("native");
    expect(native?.name).toBe("Rakazo memory");
    // No endpoint exists to show, so the label must not look like one.
    expect(native?.connectedLabel(config("native", {}))).toBe("Built into this deployment");
  });

  it("still labels an external Honcho connection by where it lives", () => {
    const honcho = memoryProviderSettings("honcho");
    expect(honcho?.connectedLabel(config("honcho", { mode: "local", baseUrl: "https://h.example" }))).toBe(
      "Self-hosted (https://h.example)",
    );
    expect(honcho?.connectedLabel(config("honcho", { workspaceId: "ws-1" }))).toBe(
      "Honcho Cloud (ws-1)",
    );
  });

  it("returns null for a provider this build does not know", () => {
    expect(memoryProviderSettings("retired-provider")).toBeNull();
  });
});

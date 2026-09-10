import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { assertBatchCapacity, assertWorkspaceCapacity, jsonBytes, starterLimits } from "../src/limits.js";

describe("portable starter capacity", () => {
  it("counts records across collections and accepts the complete boundary", () => {
    const state = { items: Array(200).fill({}), outfits: Array(400).fill({}), wear_events: Array(400).fill({}) };
    expect(() => assertWorkspaceCapacity(state)).not.toThrow();
    expect(() => assertWorkspaceCapacity({ ...state, plans: [{}] })).toThrow(/1000/);
    expect(() => assertWorkspaceCapacity({ items: Array(201).fill({}) })).toThrow(/200/);
  });

  it("limits UTF-8 bytes rather than character counts", () => {
    const state = { items: [], notes: "" };
    const available = starterLimits.workspaceBytes - jsonBytes(state);
    state.notes = "衣".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    expect(jsonBytes(state)).toBe(starterLimits.workspaceBytes);
    expect(() => assertWorkspaceCapacity(state)).not.toThrow();
    state.notes += "衣";
    expect(() => assertWorkspaceCapacity(state)).toThrow(/文字信息/);
  });

  it("keeps an uncompressed full-capacity portable ZIP below both archive limits", () => {
    const files: Record<string, Uint8Array> = { "manifest.json": new Uint8Array(starterLimits.manifestBytes) };
    let remaining = starterLimits.imageStorageBytes;
    for (let index = 0; index < starterLimits.imageCount; index++) {
      const size = Math.min(starterLimits.imageBytes, Math.ceil(remaining / (starterLimits.imageCount - index)));
      const name = index.toString(16).padStart(32, "0") + "-original.jpg";
      files["images/" + name] = new Uint8Array(size);
      remaining -= size;
    }
    expect(remaining).toBe(0);
    const expanded = Object.values(files).reduce((sum, file) => sum + file.length, 0);
    expect(expanded).toBeLessThan(starterLimits.expandedBytes);
    const archive = zipSync(files, { level: 0 });
    expect(archive.length).toBeGreaterThan(expanded);
    expect(archive.length).toBeLessThan(starterLimits.archiveBytes);
  });

  it("reserves D1 query headroom and rejects an oversized batch before execution", () => {
    expect(() => assertBatchCapacity(Array(starterLimits.batchStatements))).not.toThrow();
    expect(() => assertBatchCapacity(Array(starterLimits.batchStatements + 1))).toThrow(/记录过多/);
    expect(starterLimits.batchStatements).toBeLessThan(1000);
  });
});

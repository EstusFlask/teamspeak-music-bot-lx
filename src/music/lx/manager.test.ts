import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { LxSourceManager } from "./manager.js";
import type { Song } from "../provider.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function manager(): LxSourceManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lx-source-test-"));
  dirs.push(dir);
  return new LxSourceManager(dir, pino({ level: "silent" }));
}

const script = `/**
 * @name 测试洛雪源
 * @description test source
 * @version 1.2.3
 * @author test
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, ({ source, action, info }) => Promise.resolve(
  action === 'musicUrl'
    ? 'https://audio.example/' + source + '/' + info.musicInfo.meta.songId + '/' + info.type
    : null
))
send(EVENT_NAMES.inited, {
  sources: {
    wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
    tx: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] },
    kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
    kw: { type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
  },
})`;

describe("LxSourceManager", () => {
  it("imports, selects and persists only supported first-version platforms", async () => {
    const m = manager();
    const source = await m.importScript(script);
    expect(source.name).toBe("测试洛雪源");
    expect(source.version).toBe("1.2.3");
    expect(source.supportedSources).toEqual(["wy", "tx", "kg"]);
    expect(m.list().activeSourceId).toBe(source.id);
    expect(m.canResolvePlatform("netease")).toBe(true);
    expect(m.canResolvePlatform("bilibili")).toBe(false);
    m.close();
  });

  it("maps native song metadata and quality into an LX musicUrl request", async () => {
    const m = manager();
    await m.importScript(script);
    const song: Song = {
      id: "003abc",
      name: "Song",
      artist: "Singer",
      album: "Album",
      duration: 245,
      coverUrl: "",
      platform: "qq",
    };
    await expect(m.resolve(song, "lossless")).resolves.toEqual({
      // tx does not advertise flac, so the runtime falls back to 320k.
      url: "https://audio.example/tx/003abc/320k",
    });
    m.close();
  });

  it("maps Kugou composite ids to the official LX meta hash shape", async () => {
    const m = manager();
    await m.importScript(script);
    const song: Song = {
      id: "abcdef1234|991|77",
      name: "Song",
      artist: "Singer",
      album: "Album",
      duration: 180,
      coverUrl: "",
      platform: "kugou",
    };
    await expect(m.resolve(song, "standard")).resolves.toEqual({
      url: "https://audio.example/kg/abcdef1234/128k",
    });
    m.close();
  });

  it("supplies Kugou's quality-specific hash through meta._qualitys", async () => {
    const m = manager();
    const qualityHashScript = script
      .replace("info.musicInfo.meta.songId", "info.musicInfo.meta._qualitys[info.type].hash")
      .replace("kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] }", "kg: { type: 'music', actions: ['musicUrl'], qualitys: ['128k', 'flac'] }");
    await m.importScript(qualityHashScript);
    const song: Song = {
      id: "lowhash|991|77",
      name: "Song",
      artist: "Singer",
      album: "Album",
      duration: 180,
      coverUrl: "",
      platform: "kugou",
      sourceMeta: { hash128: "lowhash", hashFlac: "flachash" },
    };
    await expect(m.resolve(song, "lossless")).resolves.toEqual({
      url: "https://audio.example/kg/flachash/flac",
    });
    m.close();
  });

  it("rejects scripts that do not support wy, tx or kg musicUrl", async () => {
    const m = manager();
    const unsupported = script.replace(
      /wy:[\s\S]*?kw:/,
      "kw:",
    );
    await expect(m.importScript(unsupported)).rejects.toThrow();
    m.close();
  });
});

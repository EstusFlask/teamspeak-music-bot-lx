import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../../logger.js";
import type { Song, SongUrlResult } from "../provider.js";
import { downloadLxScript } from "./http.js";
import { LxScriptRuntime, type LxRuntimeInit, type LxUpdateAlert } from "./runtime.js";

export type LxPlatform = "wy" | "tx" | "kg";
export type LxQuality = "128k" | "320k" | "flac" | "flac24bit";

export interface LxSourceInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  homepage: string;
  importUrl?: string;
  supportedSources: LxPlatform[];
  qualities: Partial<Record<LxPlatform, LxQuality[]>>;
  allowUpdateAlerts: boolean;
  createdAt: string;
  updatedAt: string;
  updateAlert?: LxUpdateAlert;
}

interface LxRegistry {
  activeSourceId: string | null;
  sources: LxSourceInfo[];
}

const PLATFORM_MAP: Partial<Record<Song["platform"], LxPlatform>> = {
  netease: "wy",
  qq: "tx",
  kugou: "kg",
};

function isSourceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function headerValue(script: string, key: string): string {
  const match = script.match(new RegExp(`^\\s*\\*?\\s*@${key}\\s+(.+?)\\s*$`, "mi"));
  return match?.[1]?.replace(/\*\/$/, "").trim() ?? "";
}

function parseScriptInfo(script: string): Omit<LxSourceInfo, "id" | "importUrl" | "supportedSources" | "qualities" | "allowUpdateAlerts" | "createdAt" | "updatedAt"> {
  const name = headerValue(script, "name");
  if (!name) throw new Error("无效的洛雪音源：文件头缺少 @name");
  return {
    name: name.slice(0, 100),
    description: headerValue(script, "description").slice(0, 300),
    version: headerValue(script, "version").slice(0, 50),
    author: headerValue(script, "author").slice(0, 100),
    homepage: headerValue(script, "homepage").slice(0, 500),
  };
}

function normalizeInit(init: LxRuntimeInit): Pick<LxSourceInfo, "supportedSources" | "qualities"> {
  const sources = init?.sources && typeof init.sources === "object" ? init.sources : {};
  const supportedSources = (["wy", "tx", "kg"] as LxPlatform[]).filter((key) => {
    const item = sources[key];
    return item?.type === "music" && Array.isArray(item.actions) && item.actions.includes("musicUrl");
  });
  if (!supportedSources.length) {
    throw new Error("该脚本不支持网易云、QQ 或酷狗的 musicUrl 操作");
  }
  const valid = new Set<LxQuality>(["128k", "320k", "flac", "flac24bit"]);
  const qualities: Partial<Record<LxPlatform, LxQuality[]>> = {};
  for (const key of supportedSources) {
    qualities[key] = (sources[key]?.qualitys ?? []).filter((q): q is LxQuality => valid.has(q as LxQuality));
  }
  return { supportedSources, qualities };
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function desiredQuality(value: string): LxQuality {
  if (["hires", "jymaster", "high", "flac24bit"].includes(value)) return "flac24bit";
  if (["lossless", "flac"].includes(value)) return "flac";
  if (["exhigh", "320", "320k", "higher"].includes(value)) return "320k";
  return "128k";
}

function chooseQuality(wanted: LxQuality, available: LxQuality[]): LxQuality | null {
  const order: LxQuality[] = ["128k", "320k", "flac", "flac24bit"];
  const start = order.indexOf(wanted);
  for (let i = start; i >= 0; i--) if (available.includes(order[i])) return order[i];
  for (let i = start + 1; i < order.length; i++) if (available.includes(order[i])) return order[i];
  return null;
}

export class LxSourceManager {
  private readonly registryPath: string;
  private registry: LxRegistry = { activeSourceId: null, sources: [] };
  private runtime?: LxScriptRuntime;
  private runtimeSourceId?: string;

  constructor(private readonly dataDir: string, private readonly logger: Logger) {
    this.registryPath = path.join(dataDir, "sources.json");
    fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  list(): { activeSourceId: string | null; sources: LxSourceInfo[] } {
    return JSON.parse(JSON.stringify(this.registry));
  }

  hasActiveSource(): boolean {
    return this.registry.sources.some((s) => s.id === this.registry.activeSourceId);
  }

  canResolvePlatform(platform: Song["platform"]): boolean {
    const sourceKey = PLATFORM_MAP[platform];
    const active = this.registry.sources.find((s) => s.id === this.registry.activeSourceId);
    return Boolean(sourceKey && active?.supportedSources.includes(sourceKey));
  }

  async importScript(script: string, importUrl?: string): Promise<LxSourceInfo> {
    if (Buffer.byteLength(script, "utf8") > 1024 * 1024) throw new Error("音源脚本不能超过 1 MB");
    if (this.registry.sources.length >= 20) throw new Error("最多只能导入 20 个洛雪音源");
    const meta = parseScriptInfo(script);
    const runtime = new LxScriptRuntime(script, { ...meta }, undefined, (level, args) =>
      this.logger.debug({ level, args }, "LX source validation log"));
    let init: LxRuntimeInit;
    try {
      init = await runtime.start();
    } finally {
      runtime.close();
    }
    const capabilities = normalizeInit(init!);
    const now = new Date().toISOString();
    const source: LxSourceInfo = {
      id: crypto.randomUUID(),
      ...meta,
      importUrl,
      ...capabilities,
      allowUpdateAlerts: true,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(this.scriptPath(source.id), script, { encoding: "utf8", mode: 0o600 });
    this.registry.sources.push(source);
    if (!this.registry.activeSourceId) this.registry.activeSourceId = source.id;
    this.save();
    return source;
  }

  async importFromUrl(url: string): Promise<LxSourceInfo> {
    const script = await downloadLxScript(url);
    return this.importScript(script, url);
  }

  setActive(id: string): void {
    if (!this.registry.sources.some((s) => s.id === id)) throw new Error("洛雪音源不存在");
    this.stopRuntime();
    this.registry.activeSourceId = id;
    this.save();
  }

  setAllowUpdateAlerts(id: string, allow: boolean): LxSourceInfo {
    const source = this.requireSource(id);
    source.allowUpdateAlerts = allow;
    if (!allow) delete source.updateAlert;
    this.save();
    return source;
  }

  remove(id: string): void {
    const index = this.registry.sources.findIndex((s) => s.id === id);
    if (index < 0) throw new Error("洛雪音源不存在");
    if (this.runtimeSourceId === id) this.stopRuntime();
    this.registry.sources.splice(index, 1);
    try { fs.rmSync(this.scriptPath(id), { force: true }); } catch { /* best effort */ }
    if (this.registry.activeSourceId === id) this.registry.activeSourceId = this.registry.sources[0]?.id ?? null;
    this.save();
  }

  async update(id: string): Promise<{ source: LxSourceInfo; changed: boolean }> {
    const current = this.requireSource(id);
    if (!current.importUrl) throw new Error("本地导入的音源没有在线更新地址，请重新导入文件");
    const script = await downloadLxScript(current.importUrl);
    const oldScript = fs.readFileSync(this.scriptPath(id), "utf8");
    if (crypto.createHash("sha256").update(oldScript).digest("hex") === crypto.createHash("sha256").update(script).digest("hex")) {
      return { source: current, changed: false };
    }
    const meta = parseScriptInfo(script);
    const runtime = new LxScriptRuntime(script, meta);
    let init: LxRuntimeInit;
    try { init = await runtime.start(); } finally { runtime.close(); }
    const capabilities = normalizeInit(init!);
    fs.writeFileSync(this.scriptPath(id), script, { encoding: "utf8", mode: 0o600 });
    Object.assign(current, meta, capabilities, { updatedAt: new Date().toISOString(), updateAlert: undefined });
    if (this.runtimeSourceId === id) this.stopRuntime();
    this.save();
    return { source: current, changed: true };
  }

  async resolve(song: Song, providerQuality: string): Promise<SongUrlResult | null> {
    const sourceKey = PLATFORM_MAP[song.platform];
    if (!sourceKey) return null;
    const selected = this.registry.sources.find((s) => s.id === this.registry.activeSourceId);
    if (!selected || !selected.supportedSources.includes(sourceKey)) return null;
    const quality = chooseQuality(desiredQuality(providerQuality), selected.qualities[sourceKey] ?? []);
    if (!quality) return null;
    const runtime = await this.ensureRuntime(selected);
    const [hash, albumAudioId, albumId] = song.platform === "kugou" ? song.id.split("|") : [song.id, "", ""];
    const advertisedQualities = selected.qualities[sourceKey] ?? [];
    const kugouHash = (type: LxQuality): string => {
      const candidate = type === "320k" ? song.sourceMeta?.hash320
        : type === "flac" ? song.sourceMeta?.hashFlac
          : type === "flac24bit" ? song.sourceMeta?.hashFlac24
            : song.sourceMeta?.hash128;
      return String(candidate ?? hash);
    };
    const qualitys = advertisedQualities.map((type) =>
      sourceKey === "kg" ? { type, size: null, hash: kugouHash(type) } : { type, size: null });
    const _qualitys = Object.fromEntries(advertisedQualities.map((type) => [
      type,
      sourceKey === "kg" ? { size: null, hash: kugouHash(type) } : { size: null },
    ]));
    const meta: Record<string, unknown> = {
      songId: sourceKey === "kg" ? hash : song.id,
      albumName: song.album,
      picUrl: song.coverUrl || null,
      qualitys,
      _qualitys,
    };
    if (sourceKey === "kg") {
      meta.hash = hash;
      if (albumAudioId) meta.albumAudioId = albumAudioId;
      if (albumId) meta.albumId = albumId;
    } else if (sourceKey === "tx") {
      meta.strMediaMid = song.sourceMeta?.strMediaMid ?? song.id;
      if (song.sourceMeta?.songId !== undefined) meta.id = song.sourceMeta.songId;
      if (song.sourceMeta?.albumId !== undefined) meta.albumId = song.sourceMeta.albumId;
    }
    const musicInfo = {
      id: song.id,
      songmid: song.platform === "kugou" ? hash : song.id,
      songId: song.platform === "kugou" ? hash : song.id,
      hash: song.platform === "kugou" ? hash : undefined,
      album_audio_id: albumAudioId || undefined,
      album_id: albumId || undefined,
      name: song.name,
      singer: song.artist,
      artist: song.artist,
      albumName: song.album,
      album: song.album,
      interval: formatDuration(song.duration),
      duration: song.duration,
      source: sourceKey,
      meta,
    };
    let value: unknown;
    try {
      value = await runtime.request({ source: sourceKey, action: "musicUrl", info: { type: quality, musicInfo } });
    } catch (err) {
      // A timeout terminates the worker. Drop the cached handle so the next
      // song gets a fresh runtime instead of a permanently-dead instance.
      this.stopRuntime();
      throw err;
    }
    const url = typeof value === "string" ? value : value && typeof value === "object" && "url" in value ? String((value as any).url) : "";
    if (!/^https?:\/\//i.test(url)) return null;
    return { url };
  }

  close(): void { this.stopRuntime(); }

  private async ensureRuntime(source: LxSourceInfo): Promise<LxScriptRuntime> {
    if (this.runtime && this.runtimeSourceId === source.id) return this.runtime;
    this.stopRuntime();
    const script = fs.readFileSync(this.scriptPath(source.id), "utf8");
    const runtime = new LxScriptRuntime(
      script,
      { name: source.name, description: source.description, version: source.version, author: source.author, homepage: source.homepage },
      (alert) => this.onUpdateAlert(source.id, alert),
      (level, args) => this.logger.debug({ sourceId: source.id, level, args }, "LX source log"),
    );
    await runtime.start();
    this.runtime = runtime;
    this.runtimeSourceId = source.id;
    return runtime;
  }

  private onUpdateAlert(id: string, alert: LxUpdateAlert): void {
    const source = this.registry.sources.find((s) => s.id === id);
    if (!source?.allowUpdateAlerts) return;
    source.updateAlert = alert;
    this.save();
  }

  private requireSource(id: string): LxSourceInfo {
    const source = this.registry.sources.find((s) => s.id === id);
    if (!source) throw new Error("洛雪音源不存在");
    return source;
  }

  private scriptPath(id: string): string { return path.join(this.dataDir, `${id}.js`); }

  private load(): void {
    if (!fs.existsSync(this.registryPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf8"));
      if (!parsed || !Array.isArray(parsed.sources)) return;
      const sources = parsed.sources.filter((s: any) => s && isSourceId(s.id) && fs.existsSync(this.scriptPath(s.id)));
      this.registry = {
        activeSourceId: typeof parsed.activeSourceId === "string" && sources.some((s: any) => s.id === parsed.activeSourceId)
          ? parsed.activeSourceId : sources[0]?.id ?? null,
        sources,
      };
    } catch (err) {
      this.logger.warn({ err }, "Failed to load LX source registry; starting empty");
    }
  }

  private save(): void {
    const temp = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.registry, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, this.registryPath);
  }

  private stopRuntime(): void {
    this.runtime?.close();
    this.runtime = undefined;
    this.runtimeSourceId = undefined;
  }
}

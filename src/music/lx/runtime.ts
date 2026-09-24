import { Worker } from "node:worker_threads";

export interface LxRuntimeInit {
  sources: Record<string, { name?: string; type?: string; actions?: string[]; qualitys?: string[] }>;
}

export interface LxUpdateAlert {
  log: string;
  updateUrl?: string;
}

export class LxScriptRuntime {
  private worker?: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly script: string,
    private readonly scriptInfo: Record<string, unknown>,
    private readonly onUpdateAlert?: (alert: LxUpdateAlert) => void,
    private readonly onLog?: (level: string, args: unknown[]) => void,
  ) {}

  start(): Promise<LxRuntimeInit> {
    if (this.worker) return Promise.reject(new Error("LX runtime already started"));
    // Production runs compiled .js; `npm run dev`/Vitest execute the .ts source
    // directly. Worker entrypoints are resolved before `--import tsx` can claim
    // the .ts extension, so bootstrap through tsx's programmatic importer.
    const sourceMode = import.meta.url.endsWith(".ts");
    const workerUrl = new URL(sourceMode ? "./worker.ts" : "./worker.js", import.meta.url);
    const workerEntry = sourceMode
      ? `void import("tsx/esm/api").then(({ tsImport }) => tsImport(${JSON.stringify(workerUrl.href)}, { parentURL: ${JSON.stringify(import.meta.url)} }))`
      : workerUrl;
    const worker = new Worker(workerEntry, {
      eval: sourceMode,
      // tsx needs the Windows temp root while running the TypeScript worker in
      // dev/tests. Production workers get an empty environment so imported
      // scripts cannot read service credentials through process.env after a
      // hypothetical VM escape.
      env: sourceMode
        ? {
            LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
            TEMP: process.env.TEMP ?? "",
            TMP: process.env.TMP ?? "",
          }
        : {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    this.worker = worker;
    return new Promise<LxRuntimeInit>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error("音源脚本初始化超时"));
      }, 5_000);
      const onMessage = (message: any) => {
        if (message?.type === "inited") {
          clearTimeout(timer);
          worker.off("message", onMessage);
          resolve(message.data as LxRuntimeInit);
        } else if (message?.type === "initError") {
          clearTimeout(timer);
          worker.off("message", onMessage);
          this.close();
          reject(new Error(message.error || "音源脚本初始化失败"));
        }
      };
      worker.on("message", onMessage);
      worker.on("message", (message: any) => this.handleMessage(message));
      worker.once("error", (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        clearTimeout(timer);
        reject(error);
        this.rejectAll(error);
      });
      worker.once("exit", (code) => {
        if (code !== 0) this.rejectAll(new Error(`音源脚本进程已退出（${code}）`));
        this.worker = undefined;
      });
      worker.postMessage({ type: "init", script: this.script, scriptInfo: this.scriptInfo });
    });
  }

  request(data: unknown, timeoutMs = 20_000): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error("音源脚本未运行"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.close();
        reject(new Error("音源解析超时，运行时已重置"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ type: "request", id, data });
    });
  }

  close(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
    this.rejectAll(new Error("音源运行时已关闭"));
  }

  private handleMessage(message: any): void {
    if (message?.type === "updateAlert") {
      const value = message.data;
      if (value && typeof value.log === "string") {
        let updateUrl: string | undefined;
        if (typeof value.updateUrl === "string") {
          try {
            const parsed = new URL(value.updateUrl);
            if (parsed.protocol === "http:" || parsed.protocol === "https:") updateUrl = parsed.toString().slice(0, 1024);
          } catch { /* ignore invalid script-provided URL */ }
        }
        this.onUpdateAlert?.({ log: value.log.slice(0, 1024), updateUrl });
      }
      return;
    }
    if (message?.type === "log") {
      this.onLog?.(String(message.level), Array.isArray(message.args) ? message.args : []);
      return;
    }
    if (message?.type !== "response") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(String(message.error)));
    else pending.resolve(message.result);
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

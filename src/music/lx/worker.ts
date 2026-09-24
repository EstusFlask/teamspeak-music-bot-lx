import crypto from "node:crypto";
import vm from "node:vm";
import zlib from "node:zlib";
import { parentPort } from "node:worker_threads";
import { lxHttpRequest } from "./http.js";

if (!parentPort) throw new Error("LX worker requires parentPort");

type Handler = (data: unknown) => Promise<unknown> | unknown;
let requestHandler: Handler | undefined;
let initialized = false;
let initData: unknown;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let nextTimer = 1;

function serializeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function makeBuffer(value: unknown, encoding?: BufferEncoding): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(value as string, encoding);
}

async function init(script: string, scriptInfo: Record<string, unknown>): Promise<void> {
  const EVENT_NAMES = { inited: "inited", request: "request", updateAlert: "updateAlert" } as const;
  const lx = {
    version: "2.0.0",
    env: "desktop",
    currentScriptInfo: { ...scriptInfo, rawScript: script },
    EVENT_NAMES,
    on(eventName: string, handler: Handler) {
      if (eventName === EVENT_NAMES.request && typeof handler === "function") requestHandler = handler;
    },
    send(eventName: string, data: unknown) {
      if (eventName === EVENT_NAMES.inited) {
        initialized = true;
        initData = data;
      } else if (eventName === EVENT_NAMES.updateAlert) {
        parentPort!.postMessage({ type: "updateAlert", data });
      }
      return Promise.resolve();
    },
    request(url: string, options: Record<string, unknown> = {}, callback: (...args: unknown[]) => void) {
      const controller = { cancelled: false };
      void lxHttpRequest(url, options).then((resp) => {
        if (controller.cancelled) return;
        const body = resp.body instanceof Uint8Array ? Buffer.from(resp.body) : resp.body;
        callback(null, { ...resp, body }, body);
      }, (err) => {
        if (!controller.cancelled) callback(err instanceof Error ? err : new Error(String(err)));
      });
      return () => { controller.cancelled = true; };
    },
    utils: {
      buffer: {
        from: makeBuffer,
        bufToString: (buffer: Uint8Array, format?: BufferEncoding) => Buffer.from(buffer).toString(format),
      },
      crypto: {
        aesEncrypt(buffer: Uint8Array, mode: string, key: Uint8Array | string, iv: Uint8Array | string) {
          const cipher = crypto.createCipheriv(mode, makeBuffer(key), makeBuffer(iv));
          return Buffer.concat([cipher.update(makeBuffer(buffer)), cipher.final()]);
        },
        md5: (input: string | Uint8Array) => crypto.createHash("md5").update(input).digest("hex"),
        randomBytes: (size: number) => crypto.randomBytes(Math.max(0, Math.min(size, 4096))),
        rsaEncrypt(buffer: Uint8Array, key: string) {
          return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, makeBuffer(buffer));
        },
      },
      zlib: {
        inflate: (buffer: Uint8Array) => new Promise<Buffer>((resolve, reject) =>
          zlib.inflate(makeBuffer(buffer), (err, value) => err ? reject(err) : resolve(value))),
        deflate: (buffer: Uint8Array) => new Promise<Buffer>((resolve, reject) =>
          zlib.deflate(makeBuffer(buffer), (err, value) => err ? reject(err) : resolve(value))),
      },
    },
  };

  const sandbox: Record<string, unknown> = {
    lx,
    console: Object.freeze({
      log: (...args: unknown[]) => parentPort!.postMessage({ type: "log", level: "debug", args: args.map(String) }),
      info: (...args: unknown[]) => parentPort!.postMessage({ type: "log", level: "debug", args: args.map(String) }),
      warn: (...args: unknown[]) => parentPort!.postMessage({ type: "log", level: "warn", args: args.map(String) }),
      error: (...args: unknown[]) => parentPort!.postMessage({ type: "log", level: "warn", args: args.map(String) }),
    }),
    setTimeout(fn: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) {
      const id = nextTimer++;
      const handle = setTimeout(() => { timers.delete(id); fn(...args); }, Math.max(0, Math.min(Number(delay) || 0, 86_400_000)));
      timers.set(id, handle);
      return id;
    },
    clearTimeout(id: number) {
      const handle = timers.get(id);
      if (handle) clearTimeout(handle);
      timers.delete(id);
    },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
  };
  const context = vm.createContext(sandbox, {
    name: "lx-custom-source",
    codeGeneration: { strings: false, wasm: false },
  });
  const compiled = new vm.Script(`"use strict";\n${script}`, { filename: "lx-source.js" });
  compiled.runInContext(context, { timeout: 3_000 });
  if (!initialized) throw new Error("音源脚本未发送 inited 事件");
  if (!requestHandler) throw new Error("音源脚本未注册 request 处理器");
  parentPort!.postMessage({ type: "inited", data: initData });
}

parentPort.on("message", async (message: any) => {
  const id = message?.id;
  try {
    if (message?.type === "init") {
      await init(String(message.script ?? ""), message.scriptInfo ?? {});
      return;
    }
    if (message?.type === "request") {
      if (!requestHandler) throw new Error("音源脚本尚未初始化");
      const result = await requestHandler(message.data);
      parentPort!.postMessage({ type: "response", id, result });
    }
  } catch (err) {
    parentPort!.postMessage({ type: message?.type === "init" ? "initError" : "response", id, error: serializeError(err) });
  }
});

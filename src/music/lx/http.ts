import dns from "node:dns/promises";
import net from "node:net";

const MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return isPrivateIp(normalized.slice(7));
  return normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb");
}

async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("无效的 HTTP 地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("仅允许 HTTP/HTTPS 地址");
  }
  if (url.username || url.password) throw new Error("地址中不能包含用户名或密码");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("不允许访问本机地址");
  }
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((x) => isPrivateIp(x.address))) {
    throw new Error("不允许访问内网或保留地址");
  }
  return url;
}

export interface LxHttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, unknown>;
  formData?: Record<string, unknown>;
  timeout?: number;
  binary?: boolean;
  maxBytes?: number;
}

export interface LxHttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: string | Uint8Array;
  url: string;
}

function makeBody(options: LxHttpOptions, headers: Headers): BodyInit | undefined {
  if (options.form) {
    headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return new URLSearchParams(
      Object.entries(options.form).map(([k, v]) => [k, String(v ?? "")]),
    );
  }
  if (options.formData) {
    const form = new FormData();
    for (const [key, value] of Object.entries(options.formData)) {
      form.append(key, String(value ?? ""));
    }
    return form;
  }
  if (options.body === undefined || options.body === null) return undefined;
  if (typeof options.body === "string" || options.body instanceof Uint8Array) {
    return options.body as BodyInit;
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(options.body);
}

/** HTTP bridge used by untrusted LX scripts and online imports. Every redirect
 * is revalidated to keep scripts away from loopback/private services. */
export async function lxHttpRequest(rawUrl: string, options: LxHttpOptions = {}): Promise<LxHttpResponse> {
  let url = await assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timeoutMs = Math.max(100, Math.min(Number(options.timeout) || DEFAULT_TIMEOUT_MS, 30_000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const headers = new Headers(options.headers ?? {});
      const response = await fetch(url, {
        method: options.method ?? (options.body || options.form || options.formData ? "POST" : "GET"),
        headers,
        body: makeBody(options, headers),
        redirect: "manual",
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("重定向响应缺少 Location");
        url = await assertPublicHttpUrl(new URL(location, url).toString());
        continue;
      }

      const maxBytes = Math.max(1024, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 4 * 1024 * 1024));
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error(`响应内容超过 ${maxBytes} 字节限制`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error(`响应内容超过 ${maxBytes} 字节限制`);
      const body = options.binary ? bytes : new TextDecoder().decode(bytes);
      return {
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        url: response.url || url.toString(),
      };
    }
    throw new Error("重定向次数过多");
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("请求超时");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadLxScript(url: string): Promise<string> {
  const response = await lxHttpRequest(url, { timeout: 15_000, maxBytes: 1024 * 1024 });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`下载音源失败（HTTP ${response.statusCode}）`);
  }
  return String(response.body);
}

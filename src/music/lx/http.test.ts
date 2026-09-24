import { describe, expect, it } from "vitest";
import { lxHttpRequest } from "./http.js";

describe("LX HTTP bridge address policy", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://localhost:3000/api",
    "http://10.0.0.1/secret",
    "http://192.168.1.10/",
    "http://[::1]/",
    "file:///etc/passwd",
  ])("rejects local, private and non-HTTP targets: %s", async (url) => {
    await expect(lxHttpRequest(url)).rejects.toThrow();
  });
});

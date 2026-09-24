import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LxSourceManager } from "../../music/lx/manager.js";
import { createLxSourcesRouter } from "./lx-sources.js";

const script = `/**
 * @name API test source
 * @version 1.0.0
 */
const { EVENT_NAMES, on, send } = globalThis.lx
on(EVENT_NAMES.request, () => Promise.resolve('https://audio.example/test.mp3'))
send(EVENT_NAMES.inited, { sources: {
  wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
} })`;

describe("LX source management API", () => {
  let dir: string;
  let manager: LxSourceManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lx-api-test-"));
    manager = new LxSourceManager(dir, pino({ level: "silent" }));
  });

  afterEach(() => {
    manager.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function app(user: any): express.Express {
    const app = express();
    app.use(express.json({ limit: "1200kb" }));
    app.use((req, _res, next) => { (req as any).user = user; next(); });
    app.use("/api/lx-sources", createLxSourcesRouter(manager, pino({ level: "silent" })));
    return app;
  }

  it("requires platform.auth for imports", async () => {
    const res = await request(app({ role: "member", capabilities: new Set() }))
      .post("/api/lx-sources/import")
      .send({ script });
    expect(res.status).toBe(403);
    expect(manager.list().sources).toHaveLength(0);
  });

  it("imports, lists, selects and deletes a local source", async () => {
    const adminApp = app({ role: "admin", capabilities: new Set() });
    const imported = await request(adminApp).post("/api/lx-sources/import").send({ script });
    expect(imported.status).toBe(201);
    expect(imported.body.source.name).toBe("API test source");
    const id = imported.body.source.id as string;

    const listed = await request(adminApp).get("/api/lx-sources");
    expect(listed.status).toBe(200);
    expect(listed.body.activeSourceId).toBe(id);
    expect(listed.body.sources[0].supportedSources).toEqual(["wy"]);

    const noOnlineUpdate = await request(adminApp).post(`/api/lx-sources/${id}/update`);
    expect(noOnlineUpdate.status).toBe(400);

    const removed = await request(adminApp).delete(`/api/lx-sources/${id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.sources).toEqual([]);
  });
});

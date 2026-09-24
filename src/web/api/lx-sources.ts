import { Router } from "express";
import type { Logger } from "../../logger.js";
import type { LxSourceManager } from "../../music/lx/manager.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { requireNotGuest } from "../middleware/requireNotGuest.js";

export function createLxSourcesRouter(manager: LxSourceManager, logger: Logger): Router {
  const router = Router();

  router.get("/", requireNotGuest, (_req, res) => res.json(manager.list()));

  router.post("/import", requirePermission("platform.auth"), async (req, res) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      const script = typeof req.body?.script === "string" ? req.body.script : "";
      if (!url && !script) {
        res.status(400).json({ error: "需要提供 url 或 script" });
        return;
      }
      const source = url ? await manager.importFromUrl(url) : await manager.importScript(script);
      res.status(201).json({ source, ...manager.list() });
    } catch (err) {
      logger.warn({ err }, "LX source import failed");
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/activate", requirePermission("platform.auth"), (req, res) => {
    try {
      manager.setActive(req.params.id);
      res.json(manager.list());
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/update", requirePermission("platform.auth"), async (req, res) => {
    try {
      const result = await manager.update(req.params.id);
      res.json({ ...result, ...manager.list() });
    } catch (err) {
      logger.warn({ err, sourceId: req.params.id }, "LX source update failed");
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch("/:id", requirePermission("platform.auth"), (req, res) => {
    try {
      if (typeof req.body?.allowUpdateAlerts !== "boolean") {
        res.status(400).json({ error: "allowUpdateAlerts must be boolean" });
        return;
      }
      const source = manager.setAllowUpdateAlerts(req.params.id, req.body.allowUpdateAlerts);
      res.json({ source, ...manager.list() });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id", requirePermission("platform.auth"), (req, res) => {
    try {
      manager.remove(req.params.id);
      res.json(manager.list());
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  return router;
}

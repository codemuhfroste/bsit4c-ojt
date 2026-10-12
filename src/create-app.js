import express from "express";
import helmet from "helmet";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { HttpError, loadUser } from "./auth.js";
import { ensureMigrated } from "./db.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import checklistRoutes from "./routes/checklist.js";

const isProd = process.env.NODE_ENV === "production";

// Browsers always send Origin on cross-site writes; reject any that is not this site.
// Together with SameSite=Lax session cookies this blocks CSRF.
function sameOriginWrites(req, _res, next) {
  const origin = req.get("origin");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.get("host")) throw new HttpError(403, "Cross-site request blocked.");
  }
  next();
}

export function createApp() {
  const app = express();
  // Vercel always sits behind exactly one proxy.
  const proxy = process.env.TRUST_PROXY || (process.env.VERCEL ? "1" : "");
  if (proxy) app.set("trust proxy", Number(proxy) || proxy);

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { "upgrade-insecure-requests": isProd ? [] : null } },
      strictTransportSecurity: isProd,
    }),
  );
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use(async (_req, _res, next) => {
    await ensureMigrated();
    next();
  });
  app.use(express.json({ limit: "10kb" }));
  app.use(sameOriginWrites);
  app.use(loadUser);

  app.use("/api", authRoutes);
  app.use("/api", checklistRoutes);
  app.use("/api/admin", adminRoutes);
  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not found.")));

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  app.use((_req, res) => res.status(404).type("text").send("Not found"));

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by their 4 arguments
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === "LIMIT_FILE_SIZE";
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: tooBig ? "File is too large (4 MB max)." : "Invalid upload." });
    }
    if (err?.status >= 400 && err.status < 500) return res.status(err.status).json({ error: "Invalid request." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  });

  return app;
}

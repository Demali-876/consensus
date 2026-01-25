import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const DATA_FILE = path.resolve(process.cwd(), "server/data/whitepapersignups.json");
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readEntries() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function registerWhitepaperSignup(app) {
  app.post("/hook/whitepaper-signup", async (req, res) => {
    try {
      const origin = req.get("origin") || "";
      const allowedOrigins = new Set([
        "https://docs.consensus.canister.software",
        "http://localhost:4321",
      ]);

      if (allowedOrigins.has(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }

      const { name: rawName, email, role = "", hp = "" } = req.body || {};

      // Honeypot
      if (hp) return res.status(200).json({ ok: true });

      const name = String(rawName || "").replace(/[0-9]/g, "").trim();
      const normalizedEmail = String(email || "").trim().toLowerCase();

      if (!name || !normalizedEmail) {
        return res.status(400).json({ ok: false, error: "Missing name or email." });
      }

      if (!EMAIL_REGEX.test(normalizedEmail)) {
        return res.status(400).json({ ok: false, error: "Invalid email format." });
      }

      await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

      const entries = await readEntries();
      const now = new Date().toISOString();

      const existing = entries.find(
        (e) => e.email?.toLowerCase() === normalizedEmail
      );

      if (existing) {
        existing.name = name;
        existing.role = role || undefined;
        existing.updatedAt = now;
      } else {
        entries.push({
          id: crypto.randomUUID(),
          name,
          email: normalizedEmail,
          role: role || undefined,
          createdAt: now,
        });
      }

      await fs.writeFile(DATA_FILE, JSON.stringify(entries, null, 2), "utf8");

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error("[whitepaper] signup failed", err);
      return res.status(500).json({ ok: false, error: "Server error." });
    }
  });

  // Preflight (CORS)
  app.options("/hook/whitepaper-signup", (req, res) => {
    const origin = req.get("origin") || "";
    const allowedOrigins = new Set([
      "https://docs.consensus.canister.software",
      "http://localhost:4321",
    ]);

    if (allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    res.status(204).end();
  });
}

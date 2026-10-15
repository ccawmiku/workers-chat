import { Miniflare } from "miniflare";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
const localDirectory = join(homedir(), ".config", "workers-chat");
await mkdir(localDirectory, { recursive: true, mode: 0o700 });
const localSecretsPath = join(localDirectory, "local-login.json");
let localSecrets;
try {
  localSecrets = JSON.parse(await readFile(localSecretsPath, "utf8"));
} catch {
  localSecrets = {
    password: randomBytes(18).toString("base64url"),
    recoveryCode: randomBytes(32).toString("hex"),
  };
  await writeFile(localSecretsPath, JSON.stringify(localSecrets), {
    mode: 0o600,
  });
}
const hash = (value) => {
  const salt = randomBytes(16).toString("hex");
  return `pbkdf2:100000:${salt}:${pbkdf2Sync(value, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex")}`;
};
try {
  await readFile(".dev.vars");
} catch {
  await writeFile(
    ".dev.vars",
    `PASSWORD_HASH=${hash(localSecrets.password)}\nRECOVERY_HASH=${hash(localSecrets.recoveryCode)}\nENCRYPTION_KEY=${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600 },
  );
}
const mf = new Miniflare({
  resourcePersistencePath: ".cloudflare/state/v3",
  workers: [
    {
      config: {
        name: "workers-chat",
        compatibilityDate: "2026-10-15",
        manifest: {
          mainModule: "index.js",
          modules: {
            "index.js": {
              type: "esm",
              contents:
                'export default {fetch(){return new Response("local")}}',
            },
          },
        },
        env: { DB: { type: "d1", name: "workers-chat" } },
      },
    },
  ],
});
try {
  const db = await mf.getD1Database("DB");
  const sql = await readFile("migrations/0001.sql", "utf8");
  const exists = await db
    .prepare("SELECT name FROM sqlite_master WHERE name='documents'")
    .first();
  if (!exists) {
    for (const statement of sql.trim().split("\n"))
      await db.prepare(statement).run();
  }
  console.log(
    "Local database initialized. Local-only login is stored in ~/.config/workers-chat/local-login.json (0600).",
  );
} finally {
  await mf.dispose();
}

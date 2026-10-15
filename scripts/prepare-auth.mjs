import { randomBytes, pbkdf2Sync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
async function readPassword() {
  if (!process.stdin.isTTY) {
    let text = "";
    for await (const part of process.stdin) text += part;
    return text.replace(/\r?\n$/, "");
  }
  process.stderr.write("输入访问密码（至少 12 个字符，输入隐藏）：");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolvePassword, reject) => {
    let value = "";
    const handler = (buffer) => {
      for (const char of buffer.toString()) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", handler);
          process.stderr.write("\n");
          resolvePassword(value);
          return;
        }
        if (char === "\u0003") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          reject(new Error("已取消"));
          return;
        }
        if (char === "\u007f") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", handler);
  });
}
const password = await readPassword();
if (password.length < 12 || password.length > 1024)
  throw new Error("密码须为 12—1024 个字符");
const hash = (value) => {
  const salt = randomBytes(16).toString("hex");
  return `pbkdf2:100000:${salt}:${pbkdf2Sync(value, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex")}`;
};
const recoveryCode = randomBytes(32).toString("hex");
const destination = resolve(
  process.argv[2] ??
    join(homedir(), ".config/workers-chat/deployment-secrets.json"),
);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
// 'wx' prevents accidentally rotating the encryption key and losing saved API keys.
await writeFile(
  destination,
  JSON.stringify(
    {
      PASSWORD_HASH: hash(password),
      RECOVERY_HASH: hash(recoveryCode),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    },
    null,
    2,
  ),
  { mode: 0o600, flag: "wx" },
);
await writeFile(destination + ".recovery.txt", recoveryCode + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  "已写入受保护的凭证文件及独立离线恢复码文件。请离线备份恢复码，并保留加密密钥以恢复服务商密钥。",
);

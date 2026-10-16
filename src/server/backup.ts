import type { Provider, Settings } from "../shared/chat";
import type { SettingsBackup } from "../shared/backup";
import { defaultSettings } from "../shared/chat";
import { Store, HttpError } from "./store";
import { decrypt, encrypt, confirmPassword } from "./security";
import { obj, validatedSettings, validatedProvider } from "./validation";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function exportSettings(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
): Promise<SettingsBackup> {
  const includeKeys = body.includeKeys === true;
  if (includeKeys) await confirmPassword(request, env, body.password);
  const store = new Store(env.DB),
    settings =
      (await store.get<Settings>("settings"))?.value ?? defaultSettings(),
    providers = [];
  for (const doc of await store.all<Provider>("provider")) {
    const { encryptedKey, ...safe } = doc.value;
    providers.push({
      ...safe,
      ...(includeKeys && encryptedKey
        ? { apiKey: await decrypt(encryptedKey, env.ENCRYPTION_KEY) }
        : {}),
    });
  }
  return {
    format: "workers-chat.settings",
    version: 1,
    createdAt: Date.now(),
    containsKeys: providers.some((p) => p.apiKey !== undefined),
    settings,
    providers,
  };
}
export async function importSettings(env: Env, body: Record<string, unknown>) {
  const data = obj(body.data);
  if (
    data.format !== "workers-chat.settings" ||
    data.version !== 1 ||
    !Array.isArray(data.providers)
  )
    throw new HttpError(400, "不是受支持的在线AI设置备份");
  if (body.mode !== "merge" && body.mode !== "replace")
    throw new HttpError(400, "请选择合并或替换");
  const incoming = validatedSettings(data.settings),
    providers = data.providers.map(validatedProvider),
    ids = new Set<string>();
  for (const p of providers) {
    if (!uuidPattern.test(p.id) || ids.has(p.id))
      throw new HttpError(400, "服务商 ID 无效或重复");
    ids.add(p.id);
  }
  const store = new Store(env.DB),
    existing = await store.all<Provider>("provider"),
    byId = new Map(existing.map((d) => [d.id, d]));
  const { results: collisions } = await env.DB.prepare(
    "SELECT id FROM documents WHERE kind!='provider' AND id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify([...ids]))
    .all<{ id: string }>();
  if (collisions.length) throw new HttpError(400, "备份 ID 与其他数据冲突");
  const settingsDoc = await store.get<Settings>("settings"),
    old = settingsDoc?.value ?? defaultSettings();
  const merged: Settings =
    body.mode === "replace"
      ? incoming
      : {
          ...old,
          ...incoming,
          parameters: { ...old.parameters, ...incoming.parameters },
          templates: [
            ...new Map(
              [...old.templates, ...incoming.templates].map((t) => [t.id, t]),
            ).values(),
          ],
        };
  const statements: D1PreparedStatement[] = [],
    warnings: string[] = [];
  for (const p of providers) {
    const previous = byId.get(p.id),
      { apiKey, ...safe } = p,
      sameAddress = previous?.value.baseUrl === p.baseUrl;
    const next: Provider = {
      ...safe,
      encryptedKey:
        apiKey !== undefined
          ? await encrypt(apiKey, env.ENCRYPTION_KEY)
          : sameAddress
            ? previous?.value.encryptedKey
            : undefined,
    };
    if (previous && !sameAddress && apiKey === undefined)
      warnings.push(`${p.name} 的地址已变更，未保留旧密钥`);
    if (body.mode === "merge" && previous && sameAddress)
      next.models = [
        ...new Map(
          [...previous.value.models, ...next.models].map((m) => [m.id, m]),
        ).values(),
      ];
    statements.push(
      ...store.planSave(p.id, "provider", next, previous?.revision ?? 0, {
        id: p.id,
      }),
    );
  }
  if (body.mode === "replace")
    for (const old of existing)
      if (!ids.has(old.id))
        statements.push(
          env.DB.prepare(
            "DELETE FROM documents WHERE id=? AND kind='provider'",
          ).bind(old.id),
        );
  statements.push(
    ...store.planSave(
      "settings",
      "settings",
      merged,
      settingsDoc?.revision ?? 0,
      { id: "settings" },
    ),
  );
  await store.commit(statements);
  return {
    providers: providers.length,
    templates: merged.templates.length,
    warnings,
  };
}

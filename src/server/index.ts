import { deviceGeneration } from "./device-generation";
import {
  type Chat,
  type Provider,
  type Settings,
  defaultSettings,
  newChat,
  addMessage,
  editMessage,
  deleteMessage,
  selectBranch,
  route,
  forkChat,
  duplicateChat,
  sanitizeUsage,
  uuid,
  findMessage,
} from "../shared/chat";
import { exportSettings, importSettings } from "./backup";
import { importChats, exportChat } from "../shared/exchange";
import { HttpError, Store, summary } from "./store";
import { PASSWORD_MIN_LENGTH } from "../shared/auth";
import {
  authenticate,
  authRow,
  rateLimit,
  verifyPassword,
  passwordHash,
  digest,
  encrypt,
  decrypt,
  secureOrigin,
  sessionCookie,
  upstreamUrl,
  redactError,
  confirmPassword,
  resetRateLimit,
  checkLoginGuard,
  failedLogin,
  resetLoginGuard,
  createLoginSession,
  LoginBlocked,
} from "./security";
import {
  readChat,
  jobOutput,
  startGeneration,
  generationStart,
  finalize,
  limitedText,
  previewRequest,
} from "./generation";
export { Generation, TitleGeneration } from "./workflow";
import {
  queueTitle,
  titleStatus,
  claimDeviceTitle,
  finishDeviceTitle,
} from "./titles";
export { Progress } from "./progress";
import { obj, str, parameters, validatedSettings } from "./validation";
import { requireMethod } from "./routing";
import {
  pluginView,
  pluginEndpoint,
  devicePluginSave,
  startPluginFlow,
  pluginState,
  finishPlugin,
  clonePlugins,
  removePlugins,
  selectPluginFlow,
  planPruneMessagePlugins,
} from "./plugins";
import { enabledPlugins, flowInjections } from "../shared/plugins";
const publicProvider = (p: Provider) => {
  const { encryptedKey, ...safe } = p;
  return { ...safe, hasKey: !!encryptedKey };
};
async function settings(store: Store) {
  return (await store.get<Settings>("settings"))?.value ?? defaultSettings();
}
async function providerList(store: Store) {
  return (await store.all<Provider>("provider")).map((doc) => doc.value);
}
async function readBody(request: Request) {
  const value = await limitedText(new Response(request.body), 10 * 1024 * 1024);
  try {
    return obj(JSON.parse(value));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "JSON 格式无效");
  }
}
async function chatState(env: Env, id: string) {
  let titleJob = await titleStatus(env, id);
  const store = new Store(env.DB),
    { doc, job } = await readChat(env, id);
  if (!doc || !doc.value.messages) throw new HttpError(404, "聊天不存在");
  const chat = doc.value;

  if (job?.kind === "plugin") {
    const output = await jobOutput(env, job.id),
      age = Date.now() - (output.updatedAt || job.created_at);
    let interrupted = job.transport === "device" ? age > 90000 : false;
    if (job.transport !== "device" && age > 15000)
      try {
        interrupted = ["errored", "terminated", "complete", "unknown"].includes(
          (await (await env.GENERATION.get(job.id)).status()).status,
        );
      } catch {}
    if (interrupted) {
      await env.PROGRESS.getByName(job.id).cancel();
      await finishPlugin(
        env,
        job.id,
        output,
        "error",
        "插件任务已断开，已保留部分输出；请手动重试，不会自动重复模型请求。",
      );
      return chatState(env, id);
    }
    const view = await pluginView(env, chat, job);
    const run = view.pluginState.runs.find((r) => r.id === job.message_id);
    if (run && output.hasData) run.output = output.content;
    return {
      chat,
      revision: doc.revision,
      job: null,
      titleJob,
      ...view,
    };
  }

  if (job) {
    const output = await jobOutput(env, job.id);
    if (
      job.transport === "device" &&
      Date.now() - (output.updatedAt || job.created_at) > 90000
    ) {
      await env.PROGRESS.getByName(job.id).cancel();
      await finalize(
        env,
        job,
        "error",
        output.content,
        output.reasoning,
        "设备直连已断开，已保留收到的部分；不会自动重复模型请求。",
      );
      const latest = await store.get<Chat>(id);
      return {
        chat: latest!.value,
        revision: latest!.revision,
        job: null,
      };
    }
    if (
      job.transport !== "device" &&
      Date.now() - (output.updatedAt || job.created_at) > 15000
    ) {
      try {
        const state = await (await env.GENERATION.get(job.id)).status();
        if (
          ["errored", "terminated", "complete", "unknown"].includes(
            state.status,
          )
        ) {
          await finalize(
            env,
            job,
            "error",
            output.hasData
              ? output.content
              : (chat.messages[job.message_id]?.content ?? ""),
            output.reasoning,
            "后台任务中断，已保留收到的部分。请手动重试为新版本。服务器不会自动重复模型请求。",
          );
          const fresh = await store.get<Chat>(id);
          return {
            chat: fresh!.value,
            revision: fresh!.revision,
            job: null,
          };
        }
      } catch {
        // A transient status lookup must not create another generation.
      }
    }
    const target = chat.messages[job.message_id];
    if (target && output.hasData)
      Object.assign(
        target,
        { content: output.content, reasoning: output.reasoning },
        { status: "running" },
      );
  }
  if (!job && !chat.titleManual) {
    try {
      const queued = await queueTitle(env, id);
      if (queued && !titleJob)
        titleJob = {
          id: queued,
          status: "pending",
          error: null,
          transport: undefined,
        };
    } catch {
      /* No retry of an existing title request. */
    }
  }
  return {
    chat,
    ...(await pluginView(env, chat)),
    ...(job?.transport === "device"
      ? { generation: await generationStart(env, job.id) }
      : {}),
    revision: doc.revision,
    titleJob,
    job: job
      ? { id: job.id, status: job.status, transport: job.transport }
      : null,
  };
}

async function api(request: Request, env: Env) {
  secureOrigin(request);
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method,
    store = new Store(env.DB),
    transport =
      request.headers.get("X-Chat-Transport") === "device"
        ? "device"
        : undefined;
  requireMethod(path, method);
  const body =
    method === "GET" || method === "HEAD" ? {} : await readBody(request);
  if (path === "/api/auth/login" || path === "/api/auth/recover") {
    const loginKey = await checkLoginGuard(request, env);
    const row = await authRow(env),
      recovery = path.endsWith("recover");
    if (
      !(await verifyPassword(
        str(body.password, 1024),
        recovery ? row.recovery_hash : row.password_hash,
      ))
    )
      return failedLogin(env, loginKey);
    if (recovery) {
      const next = str(body.newPassword, 1024);
      if (next.length < PASSWORD_MIN_LENGTH)
        throw new HttpError(400, `新密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
      const code = uuid() + uuid();
      const changed = await env.DB.batch([
        env.DB.prepare(
          "UPDATE auth SET password_hash=?,recovery_hash=? WHERE id=1 AND recovery_hash=?",
        ).bind(
          await passwordHash(next),
          await passwordHash(code),
          row.recovery_hash,
        ),
        env.DB.prepare("DELETE FROM sessions WHERE (SELECT changes())>0"),
      ]);
      if (!changed[0]!.meta.changes) throw new HttpError(401, "恢复码已失效");
      await resetRateLimit(request, env);
      await resetLoginGuard(env, loginKey);
      return Response.json({
        ok: true,
        recoveryConsumed: true,
        recoveryCode: code,
      });
    }
    const token = uuid() + uuid();
    const failedAttempts = await createLoginSession(
      request,
      env,
      loginKey,
      await digest(token),
      row.password_hash,
    );
    await resetRateLimit(request, env);
    return Response.json(
      { ok: true, failedAttempts },
      { headers: { "Set-Cookie": sessionCookie(request, token) } },
    );
  }
  if (path === "/api/auth/status" || path === "/api/bootstrap") {
    try {
      await authenticate(request, env);
      if (path === "/api/auth/status")
        return Response.json({ authenticated: true });
      const id = url.searchParams.get("chatId");
      const [chats, groups, providers, config, current] = await Promise.all([
        store.list("chat"),
        store.list("group"),
        providerList(store),
        settings(store),
        id
          ? chatState(env, id).catch((e) => {
              if (e instanceof HttpError && e.status === 404) return null;
              throw e;
            })
          : null,
      ]);
      return Response.json({
        authenticated: true,
        chats,
        groups,
        providers: providers.map(publicProvider),
        settings: config,
        current,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401)
        return Response.json({ authenticated: false });
      throw e;
    }
  }
  const session = await authenticate(request, env);
  const pluginDevice = path.match(
    /^\/api\/plugins\/jobs\/([^/]+)\/(checkpoint|finish)$/,
  );
  if (pluginDevice)
    return Response.json(
      await devicePluginSave(env, pluginDevice[1]!, pluginDevice[2]!, body),
    );
  if (path === "/api/navigation") {
    const [chats, groups] = await Promise.all([
      store.list("chat"),
      store.list("group"),
    ]);
    return Response.json({ chats, groups });
  }
  if (path === "/api/config") {
    const [providers, config] = await Promise.all([
      providerList(store),
      settings(store),
    ]);
    return Response.json({
      providers: providers.map(publicProvider),
      settings: config,
    });
  }
  const watch = path.match(/^\/api\/jobs\/([^/]+)\/events$/);
  if (watch) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      throw new HttpError(426, "需要 WebSocket");
    if (request.headers.get("Origin") !== url.origin)
      throw new HttpError(403, "请求来源无效");
    const title = url.searchParams.get("kind") === "title",
      id = watch[1]!;
    const exists = await env.DB.prepare(
      title
        ? "SELECT id FROM title_jobs WHERE id=?"
        : "SELECT id FROM jobs WHERE id=?",
    )
      .bind(id)
      .first();
    if (!exists) throw new HttpError(404, "任务不存在");
    return env.PROGRESS.getByName((title ? "title-" : "") + id).fetch(request);
  }
  const deviceMatch = path.match(
    /^\/api\/device\/jobs\/([^/]+)\/(checkpoint|finish)$/,
  );
  if (deviceMatch)
    return deviceGeneration(env, deviceMatch[1]!, deviceMatch[2]!, body);
  const titleDeviceMatch = path.match(
    /^\/api\/device\/titles\/([^/]+)\/(claim|finish)$/,
  );
  if (titleDeviceMatch)
    return Response.json(
      titleDeviceMatch[2] === "claim"
        ? await claimDeviceTitle(env, titleDeviceMatch[1]!)
        : await finishDeviceTitle(env, titleDeviceMatch[1]!, body),
    );
  if (path === "/api/auth/logout") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(session)
      .run();
    return Response.json(
      { ok: true },
      {
        headers: {
          "Set-Cookie":
            "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        },
      },
    );
  }
  if (path === "/api/auth/sessions" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT token_hash,device,created_at FROM sessions ORDER BY created_at DESC",
    ).all<{ token_hash: string; device: string; created_at: number }>();
    return Response.json(
      results.map((s) => ({
        id: s.token_hash,
        device: s.device,
        createdAt: s.created_at,
        current: s.token_hash === session,
      })),
    );
  }
  if (path === "/api/auth/revoke") {
    if (body.all === true) await env.DB.prepare("DELETE FROM sessions").run();
    else
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(str(body.id, 128))
        .run();
    return Response.json({ ok: true });
  }
  if (path === "/api/auth/password") {
    await rateLimit(request, env);
    const row = await authRow(env);
    if (!(await verifyPassword(str(body.password, 1024), row.password_hash)))
      throw new HttpError(401, "密码错误");
    const next = str(body.newPassword, 1024);
    if (next.length < PASSWORD_MIN_LENGTH)
      throw new HttpError(400, `新密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
    const recovery = uuid() + uuid();
    const changed = await env.DB.batch([
      env.DB.prepare(
        "UPDATE auth SET password_hash=?,recovery_hash=? WHERE id=1 AND password_hash=? AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)",
      ).bind(
        await passwordHash(next),
        await passwordHash(recovery),
        row.password_hash,
        session,
      ),
      env.DB.prepare("DELETE FROM sessions WHERE (SELECT changes())>0"),
    ]);
    if (!changed[0]!.meta.changes) throw new HttpError(401, "登录或密码已失效");
    await resetRateLimit(request, env);
    return Response.json({ ok: true, recoveryCode: recovery });
  }
  if (path === "/api/settings/export" && method === "POST")
    return Response.json(await exportSettings(request, env, body));
  if (path === "/api/settings/import" && method === "POST")
    return Response.json(await importSettings(env, body));
  if (path === "/api/auth/recovery-code" && method === "POST") {
    await confirmPassword(request, env, body.password);
    const code = uuid() + uuid();
    const changed = await env.DB.prepare(
      "UPDATE auth SET recovery_hash=? WHERE id=1 AND EXISTS(SELECT 1 FROM sessions WHERE token_hash=?)",
    )
      .bind(await passwordHash(code), session)
      .run();
    if (!changed.meta.changes) throw new HttpError(401, "登录已失效");
    return Response.json({ recoveryCode: code });
  }
  if (path === "/api/settings" && method === "GET")
    return Response.json(await settings(store));
  if (path === "/api/settings" && method === "PUT") {
    const doc = await store.get<Settings>("settings"),
      next = validatedSettings(body);
    await store.save("settings", "settings", next, doc?.revision ?? 0, {
      id: "settings",
    });
    return Response.json(next);
  }
  if (path === "/api/providers" && method === "GET")
    return Response.json((await providerList(store)).map(publicProvider));
  if (path === "/api/providers" && method === "POST") {
    const id = typeof body.id === "string" ? body.id : uuid();
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new HttpError(400, "服务商 ID 无效");
    const doc = await store.get<Provider>(id);
    if (
      doc &&
      !(await store.list<{ id: string }>("provider")).some((p) => p.id === id)
    )
      throw new HttpError(400, "提供商 ID 无效");
    const p: Provider = {
      id,
      name: str(body.name, 100),
      baseUrl: upstreamUrl(str(body.baseUrl, 2000)),
      prefix: str(body.prefix ?? "", 100),
      encryptedKey: doc?.value.encryptedKey,
      models: doc?.value.models ?? [],
    };
    if (typeof body.apiKey === "string" && body.apiKey)
      p.encryptedKey = await encrypt(
        str(body.apiKey, 8192),
        env.ENCRYPTION_KEY,
      );
    if (
      doc?.value.encryptedKey &&
      doc.value.baseUrl !== p.baseUrl &&
      (typeof body.apiKey !== "string" || !body.apiKey)
    )
      throw new HttpError(
        400,
        "修改地址时请重新输入密钥，避免将旧密钥发送到其他主机",
      );
    if (body.refreshModels === false) {
      await store.save(id, "provider", p, doc?.revision ?? 0, { id: p.id });
      return Response.json(publicProvider(p));
    }
    let list: { data?: { id: string }[] };
    if (transport === "device") {
      if (!Array.isArray(body.models))
        throw new HttpError(400, "缺少设备获取的模型列表");
      list = {
        data: body.models.map((item) => ({ id: str(obj(item).id, 1000) })),
      };
    } else {
      const key = p.encryptedKey
        ? await decrypt(p.encryptedKey, env.ENCRYPTION_KEY)
        : "";
      const signal = AbortSignal.timeout(20000);
      const response = await fetch(p.baseUrl + "/models", {
        headers: key ? { Authorization: "Bearer " + key } : {},
        redirect: "manual",
        signal,
      });
      if (!response.ok)
        throw new HttpError(
          400,
          `获取模型失败 HTTP ${response.status}：${redactError(await limitedText(response, 8192, signal), key)}`,
        );
      list = JSON.parse(
        await limitedText(response, 2 * 1024 * 1024, signal),
      ) as {
        data?: { id: string }[];
      };
      if (
        !Array.isArray(list.data) ||
        list.data.some((m) => typeof m.id !== "string")
      )
        throw new HttpError(400, "上游模型列表格式无效");
    }
    if (
      !Array.isArray(list.data) ||
      list.data.length > 10000 ||
      list.data.some(
        (m) => typeof m.id !== "string" || !m.id || m.id.length > 1000,
      )
    )
      throw new HttpError(400, "上游模型列表格式无效");
    p.models = [...new Set(list.data.map((m) => m.id))].map(
      (id) =>
        p.models.find((m) => m.id === id) ?? {
          id,
          enabled: false,
          capacity: 1048576,
          parameters: {},
        },
    );
    await store.save(id, "provider", p, doc?.revision ?? 0, { id: p.id });
    return Response.json(publicProvider(p));
  }
  const providerMatch = path.match(
    /^\/api\/providers\/([^/]+)(?:\/(key|models|test))?$/,
  );
  if (providerMatch) {
    const doc = await store.get<Provider>(providerMatch[1]!);
    if (!doc || !doc.value.models) throw new HttpError(404, "服务商不存在");
    const p = doc.value;
    if (providerMatch[2] === "key") {
      await confirmPassword(request, env, body.password);
      return Response.json({
        apiKey: p.encryptedKey
          ? await decrypt(p.encryptedKey, env.ENCRYPTION_KEY)
          : "",
      });
    }
    if (providerMatch[2] === "test" && method === "POST") {
      const model = p.models.find((m) => m.id === body.modelId);
      if (!model) throw new HttpError(400, "请选择服务商已有模型");
      const effort = body.effort ?? "max";
      if (
        !["inherit", "none", "low", "medium", "high", "max"].includes(
          String(effort),
        )
      )
        throw new HttpError(400, "思考强度无效");
      const key = p.encryptedKey
          ? await decrypt(p.encryptedKey, env.ENCRYPTION_KEY)
          : "",
        started = Date.now(),
        defaults = await settings(store);
      const signal = AbortSignal.timeout(120000);
      const response = await fetch(p.baseUrl + "/chat/completions", {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify({
          model: model.id,
          stream: false,
          ...defaults.parameters,
          ...model.parameters,
          ...(effort !== "inherit" ? { reasoning_effort: effort } : {}),
          messages: [{ role: "user", content: "请只回复 OK。" }],
        }),
        signal,
      });
      const text = await limitedText(response, 65536, signal);
      if (!response.ok)
        throw new HttpError(
          400,
          `连通性测试 HTTP ${response.status}：${redactError(text, key)}`,
        );
      const data = JSON.parse(text) as {
        choices?: unknown[];
        usage?: Record<string, unknown>;
      };
      if (!data.choices?.length) throw new HttpError(400, "接口未返回模型回答");
      return Response.json({
        ok: true,
        modelId: model.id,
        elapsedMs: Date.now() - started,
        usage: sanitizeUsage(data.usage),
      });
    }
    if (providerMatch[2] === "models") {
      if (!Array.isArray(body.models))
        throw new HttpError(400, "模型配置格式无效");
      for (const item of body.models) {
        const m = obj(item),
          existing = p.models.find((v) => v.id === m.id);
        if (!existing) throw new HttpError(400, "不能手动添加模型");
        if (typeof m.enabled === "boolean") existing.enabled = m.enabled;
        if (m.capacity !== undefined) {
          if (
            typeof m.capacity !== "number" ||
            !Number.isSafeInteger(m.capacity) ||
            m.capacity < 1
          )
            throw new HttpError(400, "容量无效");
          existing.capacity = m.capacity;
        }
        if (m.parameters !== undefined)
          existing.parameters = parameters(m.parameters);
      }
      await store.save(p.id, "provider", p, doc.revision, { id: p.id });
      return Response.json(publicProvider(p));
    }
    if (method === "DELETE") {
      await store.remove(p.id);
      return Response.json({ ok: true });
    }
  }
  if (path === "/api/groups" && method === "GET")
    return Response.json(await store.list("group"));
  if (path === "/api/groups" && method === "POST") {
    const group = {
      id: uuid(),
      name: str(body.name, 100),
      updatedAt: Date.now(),
    };
    await store.save(group.id, "group", group, 0, group);
    return Response.json(group);
  }
  const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
  if (groupMatch) {
    const doc = await store.get<{
      id: string;
      name: string;
      updatedAt: number;
    }>(groupMatch[1]!);
    const groupExists = await env.DB.prepare(
      "SELECT id FROM documents WHERE id=? AND kind='group'",
    )
      .bind(groupMatch[1]!)
      .first();
    if (!doc || !groupExists) throw new HttpError(404, "分组不存在");
    if (method === "PATCH") {
      const name = str(body.name, 100).trim();
      if (!name) throw new HttpError(400, "分组名称不能为空");
      const group = { ...doc.value, name, updatedAt: Date.now() };
      await store.save(group.id, "group", group, doc.revision, group);
      return Response.json(group);
    }
    if (method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE documents SET summary=json_set(summary,'$.groupId',NULL) WHERE kind='chat' AND json_extract(summary,'$.groupId')=?",
        ).bind(doc.value.id),
        env.DB.prepare(
          "DELETE FROM documents WHERE id=? AND kind='group'",
        ).bind(doc.value.id),
      ]);
      return Response.json({ ok: true });
    }
  }
  if (path === "/api/chats" && method === "GET")
    return Response.json(await store.list("chat"));
  if (path === "/api/chats" && method === "POST") {
    const chat = newChat(
      (await settings(store)).defaultModel,
      typeof body.groupId === "string" ? body.groupId : null,
    );
    await store.save(chat.id, "chat", chat, 0, summary(chat));
    return Response.json(chat);
  }
  if (path === "/api/import/preview" || path === "/api/import") {
    const result = importChats(body.data);
    if (path.endsWith("preview"))
      return Response.json({
        count: result.chats.length,
        branches: result.branches,
        attachments: result.attachments,
        failures: result.failures,
      });
    // Plan the whole request before writing. A free-query limit or oversized
    // batch must not leave an unreported, partially imported set of chats.
    const statements = result.chats.flatMap((chat) =>
      store.planSave(chat.id, "chat", chat, 0, summary(chat)),
    );
    if (statements.length) await store.commit(statements);
    return Response.json({
      ids: result.chats.map((c) => c.id),
      failures: result.failures,
    });
  }
  const match = path.match(/^\/api\/chats\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    const id = match[1]!,
      action = match[2] ?? "";
    if (action === "draft" && method === "PUT") {
      await store.setDraft(id, str(body.draft));
      return Response.json({ ok: true });
    }
    if (action === "" && method === "GET")
      return Response.json(await chatState(env, id));
    const { doc, job } = await readChat(env, id);
    if (!doc || !doc.value.messages) throw new HttpError(404, "聊天不存在");
    const chat = doc.value;
    if (action === "plugins")
      return Response.json(
        await pluginEndpoint(env, doc, body, job, transport),
      );
    if (action === "title" && method === "POST") {
      if (job) throw new HttpError(409, "请等待当前回答完成");
      return Response.json(
        { jobId: await queueTitle(env, id, true, transport) },
        { status: 202 },
      );
    }
    if (action === "title-status" && method === "GET")
      return Response.json(await titleStatus(env, id));
    if (action === "export") return Response.json(exportChat(chat));
    if (action === "seen") {
      chat.unread = false;
      await store.save(id, "chat", chat, doc.revision, summary(chat));
      return Response.json({ ok: true });
    }
    if (action === "preview")
      return Response.json(
        previewRequest(
          chat,
          await settings(store),
          await providerList(store),
          body.draft === undefined ? chat.draft : str(body.draft),
        ).request,
      );
    if (action === "stop") {
      if (job?.kind === "plugin")
        return Response.json(
          await pluginEndpoint(env, doc, { action: "cancel" }, job, transport),
        );
      if (job) {
        const output = await env.PROGRESS.getByName(job.id).cancel();
        const seedContent = chat.messages[job.message_id]?.content ?? "";
        await finalize(
          env,
          job,
          "stopped",
          output.hasData ? output.content : seedContent,
          output.reasoning,
        );
        try {
          await (await env.GENERATION.get(job.id)).terminate();
        } catch {
          /* Already finished. */
        }
      }
      return Response.json({ ok: true });
    }
    if (action === "" && method === "PATCH") {
      if (body.title !== undefined) {
        chat.title = str(body.title, 500);
        chat.titleManual = true;
        chat.titleRevision = uuid();
      }
      for (const k of ["pinned", "archived", "deleted", "unread"] as const)
        if (typeof body[k] === "boolean") chat[k] = body[k];
      if (body.groupId === null || typeof body.groupId === "string")
        chat.groupId = body.groupId;
      if (body.model !== undefined) {
        if (body.model === null) chat.model = null;
        else {
          const ref = obj(body.model);
          chat.model = {
            providerId: str(ref.providerId, 128),
            modelId: str(ref.modelId, 500),
          };
        }
      }
      if (body.effort !== undefined) {
        if (
          !["inherit", "none", "low", "medium", "high", "max"].includes(
            str(body.effort),
          )
        )
          throw new HttpError(400, "思考强度无效");
        chat.effort = body.effort as Chat["effort"];
      }
      if (body.parameters !== undefined)
        chat.parameters = parameters(body.parameters);
      for (const k of ["stream"] as const)
        if (typeof body[k] === "boolean") chat[k] = body[k];
      if (body.rounds !== undefined) {
        if (body.rounds === null) delete chat.rounds;
        else if (
          typeof body.rounds === "number" &&
          Number.isSafeInteger(body.rounds) &&
          body.rounds > 0
        )
          chat.rounds = body.rounds;
        else throw new HttpError(400, "上下文轮数无效");
      }
      if (body.system !== undefined) {
        if (!Array.isArray(body.system))
          throw new HttpError(400, "模板格式无效");
        chat.system = body.system.map((v) => {
          const t = obj(v);
          return {
            id: str(t.id, 128),
            name: str(t.name, 200),
            content: str(t.content),
          };
        });
      }
      if (body.templateMode === "replace" || body.templateMode === "append")
        chat.templateMode = body.templateMode;
      chat.updatedAt = Date.now();
      await store.save(id, "chat", chat, doc.revision, summary(chat));
      return Response.json(chat);
    }
    if (job) throw new HttpError(409, "当前聊天仍在生成，请先停止或等待完成");
    if (action === "duplicate") {
      const copy = duplicateChat(
        chat,
        (await store.list<{ title: string }>("chat")).map((c) => c.title),
      );
      await clonePlugins(env, chat, copy);
      await store.save(copy.id, "chat", copy, 0, summary(copy));
      return Response.json(copy);
    }
    if (action === "permanent" && method === "DELETE") {
      if (!chat.deleted) throw new HttpError(400, "请先移入回收站");
      await removePlugins(env, id);
      await store.remove(id);
      return Response.json({ ok: true });
    }
    if (chat.deleted) throw new HttpError(400, "请先从回收站恢复聊天");
    const message =
      typeof body.messageId === "string"
        ? findMessage(chat, body.messageId)
        : null;
    if (action === "send") {
      if (chat.pluginPending)
        throw new HttpError(409, "请先回答、使用或取消当前插件流程");
      const text = str(body.content);
      if (!text.trim()) throw new HttpError(400, "消息不能为空");
      addMessage(chat, "user", text);
      chat.draft = "";
      const currentSettings = await settings(store);
      if (
        await startPluginFlow(
          env,
          chat,
          doc.revision,
          currentSettings,
          transport,
          body.debugPlugins === true,
          undefined,
          true,
        )
      )
        return Response.json({ pluginFlow: true }, { status: 202 });
      const jobId = await startGeneration(
        env,
        chat,
        doc.revision,
        await settings(store),
        await providerList(store),
        undefined,
        true,
        transport,
      );
      return Response.json(await generationStart(env, jobId), { status: 202 });
    }
    if (
      action === "regenerate" ||
      action === "retry" ||
      action === "continue"
    ) {
      if (!message || message.role !== "assistant")
        throw new HttpError(400, "请选择 AI 回答");
      if (action === "regenerate") {
        const question = route(chat, message.id).findLast(
          (m) => m.role === "user",
        );
        if (!question)
          throw new HttpError(400, "这条回答没有关联的用户问题，无法重新发送");
        addMessage(chat, "user", question.content, question.parentId);
      } else chat.currentId = message.parentId;
      const currentSettings = await settings(store);
      if (
        action === "regenerate" &&
        (await startPluginFlow(
          env,
          chat,
          doc.revision,
          currentSettings,
          transport,
          false,
          message.id,
        ))
      )
        return Response.json({ pluginFlow: true }, { status: 202 });
      const pluginData = chat.plugins?.length
        ? (await pluginState(env, id)).value
        : null;
      const previousFlow = pluginData?.flows.findLast(
        (f) => f.mainMessageId === message.id || f.userId === message.parentId,
      );
      const jobId = await startGeneration(
        env,
        chat,
        doc.revision,
        await settings(store),
        await providerList(store),
        action === "continue" ? message.id : undefined,
        false,
        transport,
        previousFlow && pluginData
          ? flowInjections(pluginData, previousFlow)
          : undefined,
      );
      return Response.json(await generationStart(env, jobId), { status: 202 });
    }
    if (action === "delete-message") {
      if (!message) throw new HttpError(404, "消息不存在");
      const removed = deleteMessage(chat, message.id),
        pluginChanges = await planPruneMessagePlugins(env, chat, removed);
      await store.commit([
        ...store.planSave(id, "chat", chat, doc.revision, summary(chat)),
        ...pluginChanges,
        ...removed.map((messageId) =>
          env.DB.prepare(
            "DELETE FROM jobs WHERE chat_id=? AND message_id=?",
          ).bind(id, messageId),
        ),
      ]);
      return Response.json(chat);
    }
    if (action === "edit") {
      if (!message) throw new HttpError(404, "消息不存在");
      editMessage(chat, message.id, str(body.content));
      if (message.role === "user") {
        if (
          await startPluginFlow(
            env,
            chat,
            doc.revision,
            await settings(store),
            transport,
          )
        )
          return Response.json({ pluginFlow: true }, { status: 202 });
        const jobId = await startGeneration(
          env,
          chat,
          doc.revision,
          await settings(store),
          await providerList(store),
          undefined,
          false,
          transport,
        );
        return Response.json(await generationStart(env, jobId), {
          status: 202,
        });
      }
    } else if (action === "select") {
      selectBranch(chat, str(body.messageId, 500));
      await selectPluginFlow(env, chat);
    } else if (action === "fork") {
      if (!message) throw new HttpError(404, "消息不存在");
      const fork = forkChat(
        chat,
        message.id,
        (await store.list<{ title: string }>("chat")).map((c) => c.title),
      );
      await clonePlugins(env, chat, fork, message.id);
      await store.save(fork.id, "chat", fork, 0, summary(fork));
      return Response.json(fork);
    } else throw new HttpError(404, "接口不存在");
    chat.updatedAt = Date.now();
    await store.save(id, "chat", chat, doc.revision, summary(chat));
    return Response.json(chat);
  }
  throw new HttpError(404, "接口不存在");
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/"))
      return new Response("Not found", { status: 404 });
    let response: Response;
    try {
      response = await api(request, env);
    } catch (e) {
      response = Response.json(
        {
          error:
            e instanceof HttpError
              ? e.message
              : "操作失败，请重试；若持续失败请检查部署配置",
          ...(e instanceof LoginBlocked ? { retryAt: e.retryAt } : {}),
        },
        {
          status: e instanceof HttpError ? e.status : 500,
          ...(e instanceof LoginBlocked
            ? {
                headers: {
                  "Retry-After": String(
                    Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000)),
                  ),
                },
              }
            : {}),
        },
      );
    }
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (new URL(request.url).protocol === "https:")
      headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;

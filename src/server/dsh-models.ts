import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";

export interface DshModelItem {
  id: string;
  name: string;
  maxTokens?: number;
  capacity: number;
  isDefault: boolean;
}

export interface DshProviderItem {
  source: "dsh";
  providerKey: string;
  name: string;
  displayName: string;
  baseUrl: string;
  prefix: string;
  apiKey: string;
  hasKey: boolean;
  apiKeyEnv?: string;
  models: DshModelItem[];
  isDefaultProvider: boolean;
}

export interface DshConfigResult {
  providers: DshProviderItem[];
  defaultModelConfig: { provider: string; model: string } | null;
}

/**
 * Read LLM providers and models configured in DeepSeek Harness.
 * Looks up ~/.dsh/profiles/desktop/cordis.patch.yml and ~/.dsh/.credentials.yaml.
 */
export function getDshConfig(): DshConfigResult {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const desktopPatchPath = path.join(
    dshHome,
    "profiles",
    "desktop",
    "cordis.patch.yml",
  );
  const credsPath = path.join(dshHome, ".credentials.yaml");

  let patchData: any[] = [];
  try {
    if (fs.existsSync(desktopPatchPath)) {
      patchData = YAML.parse(fs.readFileSync(desktopPatchPath, "utf8")) || [];
    }
  } catch (err) {
    console.warn("[WorkersChat] Failed to read cordis.patch.yml:", err);
  }

  let credsData: { refs?: Record<string, string> } = { refs: {} };
  try {
    if (fs.existsSync(credsPath)) {
      credsData = YAML.parse(fs.readFileSync(credsPath, "utf8")) || { refs: {} };
    }
  } catch (err) {
    console.warn("[WorkersChat] Failed to read .credentials.yaml:", err);
  }

  let defaultModelConfig: { provider: string; model: string } | null = null;
  const providers: DshProviderItem[] = [];

  for (const item of patchData) {
    if (!item) continue;
    if (item.id === "agent-default-model" && item.config) {
      defaultModelConfig = item.config;
    }
    if (item.config && item.config.providers) {
      for (const [pKey, pVal] of Object.entries(item.config.providers) as [string, any][]) {
        if (!pVal) continue;
        let apiKey = "";
        if (pVal.apiKeyEnv) {
          apiKey =
            credsData.refs?.[pVal.apiKeyEnv] ||
            process.env[pVal.apiKeyEnv] ||
            "";
        }
        const models: DshModelItem[] = (pVal.models || []).map((m: any) => ({
          id: m.id,
          name: m.name || m.id,
          maxTokens: m.maxTokens,
          capacity: m.maxTokens || 65536,
          isDefault: defaultModelConfig
            ? defaultModelConfig.provider === pKey &&
              defaultModelConfig.model === m.id
            : false,
        }));

        const displayName = pVal.displayName
          ? String(pVal.displayName).replace(/\/$/, "")
          : pKey;

        providers.push({
          source: "dsh",
          providerKey: pKey,
          name: `${displayName} (DSH)`,
          displayName,
          baseUrl: (pVal.baseURL || "").replace(/\/$/, ""),
          prefix: pVal.displayName || `${displayName}/`,
          apiKey,
          hasKey: !!apiKey,
          apiKeyEnv: pVal.apiKeyEnv,
          models,
          isDefaultProvider: defaultModelConfig?.provider === pKey,
        });
      }
    }
  }

  return { providers, defaultModelConfig };
}

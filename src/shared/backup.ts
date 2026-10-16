import type { Provider, Settings } from "./chat";
export type SettingsBackup = {
  format: "workers-chat.settings";
  version: 1;
  createdAt: number;
  containsKeys: boolean;
  settings: Settings;
  providers: (Omit<Provider, "encryptedKey"> & { apiKey?: string })[];
};

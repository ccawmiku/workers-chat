import { writable } from "svelte/store";
export const theme = writable("light");
export const user = writable({ id: "local", name: "你" });
export const models = writable<{ id: string; name: string }[]>([]);

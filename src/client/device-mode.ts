let enabled = false;
try {
  enabled = localStorage.getItem("device-direct") === "true";
} catch {
  /* unavailable storage */
}
export const deviceMode = () => enabled;
export function setDeviceMode(value: boolean) {
  enabled = value;
  try {
    localStorage.setItem("device-direct", String(value));
  } catch {
    /* page-only mode */
  }
}

import type { ModelRef } from "../shared/chat";
import type { PluginRequest } from "../shared/plugins";
import { useCacheReading } from "./cache-usage";
export function CacheIndicator({
  usage,
  id,
  preview,
}: {
  usage?: unknown;
  id?: string;
  preview?: { request: PluginRequest; modelRef: ModelRef };
}) {
  const reading = useCacheReading(usage, id, preview);
  return (
    <small
      className="plugin-chip-cache"
      title={reading?.source}
      data-cache-source={reading?.source}
    >
      {reading
        ? `${reading.source.startsWith("本地") ? "前缀约" : "缓存"} ${reading.percent}`
        : ""}
    </small>
  );
}

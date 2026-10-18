import { useEffect, useRef } from "react";
import { mount, unmount } from "svelte";
import { writable } from "svelte/store";
import Bridge from "../vendor/open-webui/Bridge.svelte";
import { type Chat, type Provider, indexChildren } from "../shared/chat";
import { models } from "../vendor/open-webui/stores";
import "./branch-overview.css";

export default function BranchOverview({
  chat,
  providers,
  onSelect,
}: {
  chat: Chat;
  providers: Provider[];
  onSelect: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const selectNode = useRef((id: string) => select.current(id)).current;
  const source = useRef(
    writable({
      history: { currentId: chat.currentId, messages: {} },
      theme: "light",
      onSelect: selectNode,
    }),
  );
  useEffect(() => {
    const element = mount(Bridge, {
      target: root.current!,
      props: { source: source.current },
    });
    return () => {
      void unmount(element);
    };
  }, []);
  useEffect(() => {
    const byParent = indexChildren(chat),
      pending = [...(byParent.get(null) ?? [])],
      messages: Record<string, unknown> = {};
    for (let index = 0; index < pending.length; index++) {
      const message = pending[index]!;
      messages[message.id] = {
        ...message,
        model: message.model
          ? message.model.providerId + "/" + message.model.modelId
          : message.role === "assistant"
            ? "AI"
            : undefined,
        childrenIds: (byParent.get(message.id) ?? []).map((child) => child.id),
        error: message.error ? { content: message.error } : undefined,
      };
      pending.push(...(byParent.get(message.id) ?? []));
    }
    models.set(
      providers.flatMap((p) =>
        p.models.map((m) => ({ id: p.id + "/" + m.id, name: p.prefix + m.id })),
      ),
    );
    const update = () =>
      source.current.set({
        history: { currentId: chat.currentId, messages },
        theme: document.documentElement.dataset.theme ?? "light",
        onSelect: selectNode,
      });
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [chat.id, chat.messages, chat.currentId, providers, selectNode]);
  return <div className="owui-overview" ref={root} aria-label="分支总览" />;
}

"use strict";
(() => {
  // src/client/dsh-client-entry.ts
  window.__ModuleLoader__.load({
    id: "dsh-plugin-workers-chat",
    factory: (require2) => {
      const React = require2("react");
      const h = React.createElement;
      function WorkersChatIcon(props = {}) {
        const size = props.size || 18;
        return h(
          "svg",
          {
            viewBox: "0 0 24 24",
            width: size,
            height: size,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 2,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": true,
            style: { display: "block" }
          },
          h("path", {
            d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
          })
        );
      }
      function WorkersChatPage() {
        return h("iframe", {
          src: "/workers-chat",
          title: "Workers Chat",
          style: {
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            backgroundColor: "#181818"
          }
        });
      }
      return {
        inject: ["slots"],
        apply(ctx) {
          const PANEL_ID = "workers-chat";
          ctx.slots.inject(
            "main",
            () => ctx.slots.register(
              {
                name: "main",
                key: PANEL_ID
              },
              WorkersChatPage
            )
          );
          ctx.slots.inject(
            "sidebar.panellist",
            () => ctx.slots.register(
              {
                name: "sidebar.panellist",
                id: PANEL_ID,
                order: 25,
                label: () => "Workers Chat"
              },
              WorkersChatIcon
            )
          );
        }
      };
    }
  });
})();

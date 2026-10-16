# Open WebUI overview components

Source: https://github.com/open-webui/open-webui/tree/v0.12.2/src/lib/components/chat/Overview

Version: v0.12.2 (2026-10-14), commit `6a18585ff4c2e5f6805f682222cfbc46dc669ef8`.

`Overview.svelte`, `Overview/{View,Flow,Node}.svelte` and the layout/pin icons are derived directly from this release. The Open WebUI License and LICENSE_HISTORY are retained here and distributed under `/licenses/`; settings acknowledge the source without implying endorsement.

Adaptations: React/Svelte bridge and local stores; app-specific user/model APIs, i18n, tooltip and avatar adapters; no remote avatar requests; remove message-favorite feature outside this app's scope; iterative ancestor checking for deep trees; no content/initialization logging. The source's Svelte Flow canvas, smooth-step edges, card markup, layout dimensions, pin/zoom/layout controls and pan/zoom interaction are preserved. Scoped compatibility CSS supplies the original Tailwind utility appearance without adding a global CSS reset.

Svelte Flow 0.1.39 is within Open WebUI's declared `^0.1.19` range and supports Svelte 5; Svelte 5.57.2 and Vite plugin 7.3.1 match this project's Vite 8 runtime.

2026-10-16 follow-up: scoped `group` margins and handle-button padding so app navigation/button styles cannot change card/edge geometry; update handle internals after orientation changes and fit the viewport after layout changes when unpinned. The React bridge keeps the node-click callback stable; clicking chooses the branch and scrolls to the exact message in the chat.

2026-10-16 icon follow-up: per user request, layout/pin/zoom/fit controls and local avatar adapters now use @lucide/svelte icons; removed the four unused derived icon files. Existing Svelte Flow controls, zoom limits, layout and graph interactions are retained.

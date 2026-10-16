<script lang="ts">
  import Overview from './Overview.svelte';
  import { theme } from './stores';
  import type { Writable } from 'svelte/store';
  import type { OverviewHistory } from './types';
  export let source: Writable<{history: OverviewHistory; theme: string; onSelect: (id: string) => void}>;
  $: theme.set($source.theme);
</script>
<Overview history={$source.history} onNodeClick={(event: {node: {id: string}}) => $source.onSelect(event.node.id)} />

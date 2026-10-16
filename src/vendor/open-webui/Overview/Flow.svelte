<!-- Adapted from Open WebUI v0.12.2. See LICENSE and PROVENANCE.md. -->
<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { getContext } from 'svelte';

	const dispatch = createEventDispatcher<{ nodeclick: { node: import('@xyflow/svelte').Node } }>();
	const i18n = { subscribe: (run: (value: {t: (value: string) => string}) => void) => { run({ t: (value: string) => value }); return () => {}; } };

	import { theme } from '../stores';
	import {
		Background,
		Controls,
		SvelteFlow,
		BackgroundVariant,
		ControlButton, useSvelteFlow, useStore
	} from '@xyflow/svelte';
  import AlignVertical from '@lucide/svelte/icons/align-vertical-distribute-center';
  import AlignHorizontal from '@lucide/svelte/icons/align-horizontal-distribute-center';
  import Pin from '@lucide/svelte/icons/pin';
  import PinSlash from '@lucide/svelte/icons/pin-off';
  import Plus from '@lucide/svelte/icons/plus';
  import Minus from '@lucide/svelte/icons/minus';
  import Maximize from '@lucide/svelte/icons/maximize';
  const { zoomIn, zoomOut, fitView } = useSvelteFlow();
  const { viewport, minZoom, maxZoom } = useStore();

	export let nodes: import('svelte/store').Writable<import('@xyflow/svelte').Node[]>;
	export let nodeTypes: import('@xyflow/svelte').NodeTypes;
	export let edges: import('svelte/store').Writable<import('@xyflow/svelte').Edge[]>;
	export let setLayoutDirection: (value: 'vertical' | 'horizontal') => void;
	export let pinned = false;
</script>

<SvelteFlow
	{nodes}
	{nodeTypes}
	{edges}
	fitView
	minZoom={0.001}
	colorMode={$theme.includes('dark')
		? 'dark'
		: $theme === 'system'
			? window.matchMedia('(prefers-color-scheme: dark)').matches
				? 'dark'
				: 'light'
			: 'light'}
	nodesConnectable={false}
	nodesDraggable={false}
	on:nodeclick={(e) => dispatch('nodeclick', e.detail)}
>
	<Controls showLock={false} showZoom={false} showFitView={false}>
    <ControlButton title="zoom in" aria-label="zoom in" disabled={$viewport.zoom >= $maxZoom} on:click={() => zoomIn()}><Plus size={16}/></ControlButton>
    <ControlButton title="zoom out" aria-label="zoom out" disabled={$viewport.zoom <= $minZoom} on:click={() => zoomOut()}><Minus size={16}/></ControlButton>
    <ControlButton title="fit view" aria-label="fit view" on:click={() => fitView()}><Maximize size={16}/></ControlButton>
		<ControlButton
			on:click={() => (pinned = !pinned)}
			title={pinned ? $i18n.t('Viewport Pinned') : $i18n.t('Viewport Unpinned')}
		>
			{#if pinned}
				<Pin size={16}/>
			{:else}
				<PinSlash size={16}/>
			{/if}
		</ControlButton>
		<ControlButton
			on:click={() => setLayoutDirection('vertical')}
			title={$i18n.t('Vertical Layout')}
		>
			<AlignVertical size={16}/>
		</ControlButton>
		<ControlButton
			on:click={() => setLayoutDirection('horizontal')}
			title={$i18n.t('Horizontal Layout')}
		>
			<AlignHorizontal size={16}/>
		</ControlButton>
	</Controls>
	<Background variant={BackgroundVariant.Dots} />
</SvelteFlow>

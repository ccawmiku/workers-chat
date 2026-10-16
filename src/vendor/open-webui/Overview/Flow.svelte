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
		ControlButton
	} from '@xyflow/svelte';
	import AlignVertical from '../icons/AlignVertical.svelte';
	import AlignHorizontal from '../icons/AlignHorizontal.svelte';
	import Pin from '../icons/Pin.svelte';
	import PinSlash from '../icons/PinSlash.svelte';

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
	<Controls showLock={false}>
		<ControlButton
			on:click={() => (pinned = !pinned)}
			title={pinned ? $i18n.t('Viewport Pinned') : $i18n.t('Viewport Unpinned')}
		>
			{#if pinned}
				<Pin />
			{:else}
				<PinSlash />
			{/if}
		</ControlButton>
		<ControlButton
			on:click={() => setLayoutDirection('vertical')}
			title={$i18n.t('Vertical Layout')}
		>
			<AlignVertical className="size-4" />
		</ControlButton>
		<ControlButton
			on:click={() => setLayoutDirection('horizontal')}
			title={$i18n.t('Horizontal Layout')}
		>
			<AlignHorizontal className="size-4" />
		</ControlButton>
	</Controls>
	<Background variant={BackgroundVariant.Dots} />
</SvelteFlow>

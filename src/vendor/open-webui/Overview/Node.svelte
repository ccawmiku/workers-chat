<!-- Adapted from Open WebUI v0.12.2. See LICENSE and PROVENANCE.md. -->
<script lang="ts">
	const WEBUI_API_BASE_URL = '';
	import { Handle, Position, useUpdateNodeInternals, type NodeProps, type Node } from '@xyflow/svelte';
	import { tick } from 'svelte';
	import type { OverviewData } from '../types';
	import { getContext } from 'svelte';

	import ProfileImage from '../ProfileImage.svelte';
	import Tooltip from '../Tooltip.svelte';

	import { getOutputText } from '../adapters';
	import { resolveLocalizedModelName } from '../adapters';

	const i18n = { subscribe: (run: (value: {language: string}) => void) => { run({ language: 'zh-CN' }); return () => {}; } };

	type $$Props = NodeProps<Node<OverviewData>>;
	export let data: $$Props['data'];
	export let id: string;
	const updateNodeInternals = useUpdateNodeInternals();
	$: if (data.direction && id) tick().then(() => updateNodeInternals(id));

	const getMessageContent = (nodeData: any) =>
		getOutputText(nodeData?.message?.output) || nodeData?.message?.content || '';

	$: messageContent = getMessageContent(data);
	$: modelName = data?.model
		? resolveLocalizedModelName(data.model, $i18n.language)
		: (data?.message?.model ?? 'Assistant');
</script>

<div
	class="px-4 py-3 shadow-md rounded-xl dark:bg-black bg-white border border-gray-100 dark:border-gray-900 w-60 h-20 group"
>
	<Tooltip
		content={data?.message?.error ? data.message.error.content : messageContent}
		class="w-full"
	>
		{#if data.message.role === 'user'}
			<div class="flex w-full">
				<ProfileImage
					src={`${WEBUI_API_BASE_URL}/users/${data.user.id}/profile/image`}
					className={'size-5 -translate-y-[1px] flex-shrink-0'}
				/>
				<div class="ml-2 flex-1 min-w-0">
					<div class=" flex justify-between items-center">
						<div class="text-xs text-black dark:text-white font-normal line-clamp-1">
							{data?.user?.name ?? 'User'}
						</div>
					</div>

					{#if data?.message?.error}
						<div class="text-red-500 line-clamp-2 text-xs mt-0.5">{data.message.error.content}</div>
					{:else}
						<div class="text-gray-500 line-clamp-2 text-xs mt-0.5">{messageContent}</div>
					{/if}
				</div>
			</div>
		{:else}
			<div class="flex w-full">
				<ProfileImage
					src={`${WEBUI_API_BASE_URL}/models/model/profile/image?id=${data.model?.id ?? data.message.model}&lang=${$i18n.language}`}
					className={'size-5 -translate-y-[1px] flex-shrink-0'}
				/>

				<div class="ml-2 flex-1 min-w-0">
					<div class=" flex justify-between items-center">
						<div class="text-xs text-black dark:text-white font-normal line-clamp-1">
							{modelName}
						</div>

					</div>

					{#if data?.message?.error}
						<div class="text-red-500 line-clamp-2 text-xs mt-0.5">
							{data.message.error.content}
						</div>
					{:else}
						<div class="text-gray-500 line-clamp-2 text-xs mt-0.5">{messageContent}</div>
					{/if}
				</div>
			</div>
		{/if}
	</Tooltip>
	<Handle
		type="target"
		position={data?.direction === 'horizontal' ? Position.Left : Position.Top}
		class="w-2 rounded-full dark:bg-gray-900"
	/>
	<Handle
		type="source"
		position={data?.direction === 'horizontal' ? Position.Right : Position.Bottom}
		class="w-2 rounded-full dark:bg-gray-900"
	/>
</div>

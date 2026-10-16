<script lang="ts">
  import UserRound from '@lucide/svelte/icons/user-round';
  import Bot from '@lucide/svelte/icons/bot';
  export let src = '';
  export let className = '';
</script>
<span class="overview-avatar {className}" aria-hidden="true">{#if src.includes('/users/')}<UserRound size={12}/>{:else}<Bot size={12}/>{/if}</span>

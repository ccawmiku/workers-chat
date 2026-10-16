<script lang="ts">
  export let src = '';
  export let className = '';
</script>
<span class="overview-avatar {className}" aria-hidden="true">{src.includes('/users/') ? 'AI' : '✦'}</span>

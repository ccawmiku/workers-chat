<script lang="ts">
  export let content = '';
  let className = '';
  export { className as class };
</script>
<div class={className} title={content}><slot /></div>

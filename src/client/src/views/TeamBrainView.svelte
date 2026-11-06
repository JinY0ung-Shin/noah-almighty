<script lang="ts">
  // 팀 브레인 (its own rail item, `#/teamBrain`). A separate view component so the
  // router remounts BrainView when switching between 내 브레인 and 팀 브레인 —
  // the same component under <svelte:component> would keep its state.
  import BrainView from "./BrainView.svelte";
</script>

<BrainView scope="team" />

<script lang="ts">
  // Inline text of a canvas widget: styled runs assembled from ELEMENTS, with
  // every run's text inserted as a text node. Nothing here parses HTML, so a
  // value like `<img onerror=…>` an avatar interpolates shows as those characters.
  import type { Seg } from "../../lib/widgetView";

  export let segs: Seg[] = [];
</script>

{#each segs as seg}{#if seg.code}<code class="wg-code">{seg.text}</code>{:else if seg.b && seg.i}<strong><em class:wg-strike={seg.s}>{seg.text}</em></strong>{:else if seg.b}<strong class:wg-strike={seg.s}>{seg.text}</strong>{:else if seg.i}<em class:wg-strike={seg.s}>{seg.text}</em>{:else if seg.s}<s>{seg.text}</s>{:else}{seg.text}{/if}{/each}

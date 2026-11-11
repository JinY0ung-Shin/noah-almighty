<script lang="ts">
  // Inline text of inline UI: styled runs assembled from ELEMENTS, with
  // every run's text inserted as a text node. Nothing here parses HTML, so a
  // value like `<img onerror=…>` an avatar interpolates shows as those characters.
  //
  // A run may be a link (`<link href>` or `[text](https://…)`): its target is an
  // absolute http(s) URL the shared library already normalized, it opens in a
  // new tab without handing this page to it, and the address is the tooltip —
  // the reader sees where it goes before following it.
  import type { Seg } from "../../lib/widgetView";

  export let segs: Seg[] = [];
</script>

{#snippet run(seg: Seg)}{#if seg.code}<code class="wg-code">{seg.text}</code>{:else if seg.b && seg.i}<strong><em class:wg-strike={seg.s}>{seg.text}</em></strong>{:else if seg.b}<strong class:wg-strike={seg.s}>{seg.text}</strong>{:else if seg.i}<em class:wg-strike={seg.s}>{seg.text}</em>{:else if seg.s}<s>{seg.text}</s>{:else}{seg.text}{/if}{/snippet}

{#each segs as seg}{#if seg.href}<a class="wg-link" href={seg.href} target="_blank" rel="noopener noreferrer" title={seg.href}>{@render run(seg)}</a>{:else if seg.problem}<span class="wg-link-broken" title={seg.problem}>{@render run(seg)}</span>{:else}{@render run(seg)}{/if}{/each}

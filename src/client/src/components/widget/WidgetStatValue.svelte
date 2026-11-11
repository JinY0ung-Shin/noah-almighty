<script lang="ts">
  // The value of a <stat>. When it appears now (lib/uiEntrance.ts), a value
  // that is one number counts up from zero in its own format ("605만원",
  // "+12.4%"); any other value rises into place. A value that CHANGES — the
  // viewer moved a slider — is simply the new value: the count is dropped.
  //
  // While it counts, the final text is still in the layout (hidden) and the
  // running number is drawn over it, so the card keeps its size and nothing
  // beside it moves.
  import { claimEntrance, countUp, countUpFormat, playSteps, riseSteps, type EntranceRule } from "../../lib/uiEntrance";

  export let text = "";
  export let entrance: EntranceRule | null = null;
  /** The value's place in the answer: what "already entered" is remembered by. */
  export let entranceKey = "";

  // The number on its way up; null shows the value itself.
  let counting: string | null = null;
  let stop = () => {};
  let entered = text;

  $: if (text !== entered) settle(text);
  function settle(next: string): void {
    entered = next;
    stop();
    stop = () => {};
    counting = null;
  }

  function begin(node: HTMLElement) {
    const ticket = entrance ? claimEntrance(entrance, entranceKey, true) : null;
    if (ticket) {
      const format = countUpFormat(text);
      stop = format ? countUp(node, format, ticket, (shown) => (counting = shown)) : playSteps(node, riseSteps(node), ticket);
    }
    return {
      destroy() {
        stop();
      },
    };
  }
</script>

<span class="stat-value wg-tabular" use:begin>{#if counting !== null}<span class="wg-count"><span class="wg-count-final" aria-hidden="true">{text}</span><span class="wg-count-now">{counting}</span></span>{:else}{text}{/if}</span>

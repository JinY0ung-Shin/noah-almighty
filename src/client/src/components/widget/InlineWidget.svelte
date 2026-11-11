<script lang="ts">
  // The place of a `widget` canvas IN the chat: where its attachment sits in
  // the answer that showed it (an anchor in the message text, like any card), so
  // the text that follows continues below the widget.
  //
  // ONE canvas is alive in ONE place. A canvas refined in a later turn gets an
  // attachment in that turn's answer too; only the LAST one (`home`) draws the
  // widget, the earlier ones just say where it went. The widget itself is the
  // same component the side panel uses for a canvas (CanvasTab, inline): state,
  // storage, fullscreen, versions, delete, submit and the render report are all
  // there, once.
  import CanvasTab from "../CanvasTab.svelte";
  import type { ChatPane, MessageAttachment } from "../../lib/types";

  export let pane: ChatPane;
  export let attachment: MessageAttachment;
  /** This attachment is the canvas's newest: the widget is drawn here. */
  export let home = false;
  /** The attachment belongs to the bubble that is still streaming. */
  export let live = false;

  $: canvas = pane.canvases.find((item) => item.id === attachment.id) ?? null;
  $: name = attachment.name || canvas?.title || "위젯";
</script>

{#if !home}
  <p class="widget-slot-note">「{name}」 위젯은 아래 답변에서 갱신됐습니다.</p>
{:else if !canvas}
  {#if live && pane.streaming}
    <!-- The attachment arrived a frame before the canvas itself. -->
    <div class="widget-slot-pending" role="status">
      <span class="widget-slot-bar" aria-hidden="true"></span>
      <span>위젯을 불러오는 중…</span>
    </div>
  {:else}
    <p class="widget-slot-note">「{name}」 위젯은 삭제되어 더 이상 볼 수 없습니다.</p>
  {/if}
{:else if canvas.contentType !== "widget"}
  <p class="widget-slot-note">「{name}」은 캔버스로 바뀌어 오른쪽 패널에 있습니다.</p>
{:else}
  <CanvasTab {pane} {canvas} active inline />
{/if}

// 인라인 UI 갤러리 (`#/uiGallery`): everything an avatar can draw in its answer
// text, one small answer per thing (lib/uiGallery.ts). Each sample is drawn by
// the chat's own renderer — AnswerUi, in its preview mode — so this page shows
// exactly what a real answer shows, charts' entrances included; under it, the
// text an avatar writes to get it.
//
// A preview has no conversation: what a control would send to the avatar is
// shown under the sample instead of being sent, and nothing is kept.
// Not in the rail: opened by its address.
import { useMemo, useRef, useState, type SyntheticEvent } from "react";

import AnswerUi from "../components/widget/AnswerUi";
import { enhanceMarkdown } from "../lib/dom";
import { renderMarkdown } from "../lib/format";
import { useAction } from "../lib/hooks";
import { scrollToStart } from "../lib/motion";
import type { ChatPane } from "../lib/types";
import { UI_GALLERY, gallerySourceMarkdown } from "../lib/uiGallery";

// What AnswerUi reads of a pane; a preview never sends, keeps or reports through it.
const pane = { id: "ui-gallery", conversationId: "", streaming: false, liveRunId: null } as unknown as ChatPane;

const sampleCount = UI_GALLERY.reduce((sum, section) => sum + section.samples.length, 0);

/** A sample's source, highlighted: its own element, mounted when the section is first opened. */
function GallerySource({ source }: { source: string }) {
  // The same html while the source is the same: the code block built around it is not thrown away by a later render.
  const html = useMemo(() => renderMarkdown(gallerySourceMarkdown(source)), [source]);
  return <div className="md" ref={useAction(enhanceMarkdown, source)} dangerouslySetInnerHTML={{ __html: html }}></div>;
}

export default function UiGalleryView() {
  // The message a sample's control would have sent, by sample id.
  const [outgoing, setOutgoing] = useState<Record<string, string>>({});
  function outboxOf(id: string): (message: string) => void {
    return (message) => {
      setOutgoing((before) => ({ ...before, [id]: message }));
    };
  }

  // A section's source is rendered when it is first opened: 30-odd highlighted code blocks nobody asked for are not.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  function onToggle(id: string, event: SyntheticEvent<HTMLDetailsElement>): void {
    if (event.currentTarget.open) setOpened((before) => (before[id] ? before : { ...before, [id]: true }));
  }

  const sections = useRef<Record<string, HTMLElement | null>>({});
  function jump(id: string): void {
    const target = sections.current[id];
    if (!target) return;
    scrollToStart(target);
    target.focus({ preventScroll: true });
  }

  return (
    <>
      <header className="view-header">
        <div>
          <h1>인라인 UI 갤러리</h1>
          <p>아바타가 답변 본문에 그릴 수 있는 것 {sampleCount}가지 — 실제 답변과 같은 방식으로 그려집니다</p>
        </div>
      </header>

      <div className="view-body scroll-thin">
        <div className="ui-gallery">
          <nav className="ui-gallery-nav" aria-label="갤러리 구역">
            {UI_GALLERY.map((section) => (
              <button key={section.id} className="btn btn-ghost btn-sm" type="button" onClick={() => jump(section.id)}>
                {section.title}
              </button>
            ))}
          </nav>

          {UI_GALLERY.map((section) => (
            <section
              key={section.id}
              className="ui-gallery-section"
              aria-labelledby={`ui-gallery-${section.id}`}
              tabIndex={-1}
              ref={(node) => {
                sections.current[section.id] = node;
              }}
            >
              <div className="ui-gallery-section-head">
                <h2 id={`ui-gallery-${section.id}`}>{section.title}</h2>
                <p>{section.intro}</p>
              </div>
              {section.samples.map((sample) => (
                <article key={sample.id} className="ui-gallery-card" data-sample={sample.id}>
                  <div className="ui-gallery-card-head">
                    <h3>{sample.title}</h3>
                    {sample.note ? <p>{sample.note}</p> : null}
                  </div>
                  {!sample.sourceOnly ? (
                    <>
                      {/* `data-entrance`: a diagram of a preview enters every time, like its charts (lib/mermaidBlock.ts). */}
                      <div className="ui-gallery-stage" data-entrance="always">
                        <AnswerUi pane={pane} text={sample.source} outbox={outboxOf(sample.id)} />
                      </div>
                      {outgoing[sample.id] ? (
                        <div className="ui-gallery-sent" role="status">
                          <span>대화에서는 이 내용이 다음 메시지로 전송됩니다. 갤러리에서는 보내지 않습니다.</span>
                          <pre>{outgoing[sample.id]}</pre>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <details className="ui-gallery-source" open={sample.sourceOnly === true} onToggle={(event) => onToggle(sample.id, event)}>
                    <summary>소스 보기</summary>
                    {opened[sample.id] || sample.sourceOnly ? <GallerySource source={sample.source} /> : null}
                  </details>
                </article>
              ))}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

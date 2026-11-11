// confluenceStorageText.ts — Confluence storage format → compact Markdown-like
// text (get_page's default body). The fixtures are storage markup the way
// Confluence Server writes it: `ac:`/`ri:` elements, CDATA bodies, XHTML
// entities. The converter's contract is total: any input returns text.

import { describe, expect, it } from "vitest";
import { confluenceStorageToText, decodeXmlEntities } from "../src/server/agent/confluenceStorageText.js";

const text = confluenceStorageToText;

/** A runbook page: layout wrapper, mention, status, panel, nested lists, code, tasks, table, image, links, unknown macros. */
const RUNBOOK = `<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>
<h1>배포 <strong>런북</strong></h1>
<p>담당: <ac:link><ri:user ri:userkey="8a7f808a6c3b1c2d016c3b1d2e3f0001" /></ac:link> &middot; 상태 <ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="11111111-2222"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">운영 중</ac:parameter></ac:structured-macro></p>
<p><ac:structured-macro ac:name="toc" ac:schema-version="1" /></p>
<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:parameter ac:name="title">주의</ac:parameter><ac:rich-text-body><p>배포 전 <a href="https://ci.internal/job/1?a=1&amp;b=2">CI</a> 확인</p></ac:rich-text-body></ac:structured-macro>
<h2>절차</h2>
<ol>
  <li>이미지 빌드
    <ul>
      <li>태그: <code>v1.2.3</code></li>
      <li><p>캐시 무시</p><ac:structured-macro ac:name="code" ac:schema-version="1"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[docker build -t app:1 . \\
  && echo "a < b && c > d"]]></ac:plain-text-body></ac:structured-macro></li>
    </ul>
  </li>
  <li>배포 <s>수동</s> <em>자동</em><br />승인 필요</li>
</ol>
<ac:task-list>
<ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><span class="placeholder-inline-tasks">백업</span></ac:task-body></ac:task>
<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>공지 <ac:link><ri:user ri:username="jlee" /></ac:link></ac:task-body></ac:task>
</ac:task-list>
<table class="confluenceTable"><colgroup><col /><col /></colgroup><tbody>
<tr><th>환경</th><th>비고</th></tr>
<tr><td>prod</td><td><ac:structured-macro ac:name="warning"><ac:rich-text-body><p>야간만</p></ac:rich-text-body></ac:structured-macro><ul><li>a|b</li><li>c</li></ul></td></tr>
<tr><td colspan="2">합계 <strong>2</strong></td></tr>
</tbody></table>
<p><ac:image ac:alt="구성도" ac:width="600"><ri:attachment ri:filename="arch &amp; flow.png" /></ac:image></p>
<p>참고: <ac:link><ri:page ri:content-title="롤백 가이드" ri:space-key="OPS" /><ac:plain-text-link-body><![CDATA[롤백]]></ac:plain-text-link-body></ac:link>, <ac:link><ri:attachment ri:filename="checklist.pdf" /></ac:link> <ac:emoticon ac:name="tick" /></p>
<ac:structured-macro ac:name="roadmap-planner"><ac:parameter ac:name="source">Q4</ac:parameter><ac:plain-text-body><![CDATA[{"lanes":1}]]></ac:plain-text-body></ac:structured-macro>
<p><ac:structured-macro ac:name="children" ac:schema-version="2"><ac:parameter ac:name="depth">2</ac:parameter></ac:structured-macro></p>
</ac:layout-cell></ac:layout-section></ac:layout>`;

const RUNBOOK_TEXT = `# 배포 런북

담당: [user mention] · 상태 [status: 운영 중]

[table of contents]

> **Info: 주의**
>
> 배포 전 [CI](https://ci.internal/job/1?a=1&b=2) 확인

## 절차

1. 이미지 빌드
   - 태그: \`v1.2.3\`
   - 캐시 무시
     \`\`\`bash
     docker build -t app:1 . \\
       && echo "a < b && c > d"
     \`\`\`
2. 배포 ~~수동~~ *자동*
   승인 필요

- [x] 백업
- [ ] 공지 @jlee

| 환경 | 비고 |
| --- | --- |
| prod | **Warning** ⏎ 야간만 ⏎ - a\\|b ⏎ - c |
| 합계 **2** | (←) |

(merged cells: (←) continues the cell to its left, (↑) the cell above)

[image: arch & flow.png — 구성도]

참고: [롤백](page: 롤백 가이드 (space OPS)), [attachment: checklist.pdf] :tick:

> **Macro roadmap-planner** (source=Q4)
>
> \`\`\`
> {"lanes":1}
> \`\`\`

[macro children: depth=2]`;

describe("confluence storage → text: a whole page", () => {
  it("renders a realistic runbook page as compact Markdown-like text", () => {
    const out = text(RUNBOOK);
    expect(out).toBe(RUNBOOK_TEXT);
    // The point of the conversion: the same content in a fraction of the characters.
    expect(out.length).toBeLessThan(RUNBOOK.length / 3);
    // No markup of the source survives, and the opaque user key never reaches the model.
    expect(out).not.toMatch(/<\/?[a-z][\w:-]*[\s>/]/i);
    expect(out).not.toContain("8a7f808a6c3b1c2d016c3b1d2e3f0001");
    expect(out).not.toContain("macro-id");
  });

  it("returns an empty string for an empty or non-string body", () => {
    expect(text("")).toBe("");
    expect(text("   \n ")).toBe("");
    expect(text(undefined as unknown as string)).toBe("");
    expect(text(null as unknown as string)).toBe("");
  });
});

describe("confluence storage → text: inline markup", () => {
  it("marks bold, italic, strike and inline code, keeping spaces outside the markers", () => {
    expect(text("<p>a <strong>bold </strong>b <em>it</em> <del>gone</del> <u>under</u> x<sub>2</sub></p>")).toBe(
      "a **bold** b *it* ~~gone~~ under x2",
    );
    // Nested or repeated emphasis is not doubled; empty emphasis leaves nothing behind.
    expect(text("<p><strong><b>x</b></strong> <strong> </strong>y <em><strong>both</strong></em></p>")).toBe(
      "**x** y ***both***",
    );
    // Inline code keeps its text literal, and a backtick inside gets a longer fence.
    expect(text("<p>run <code>npm <strong>test</strong></code> and <code>a`b</code></p>")).toBe(
      "run `npm test` and ``a`b``",
    );
  });

  it("keeps line breaks, collapses source whitespace and drops empty paragraphs", () => {
    expect(text("<p>one<br/>two<br />  three</p>\n\n<p>  </p><p>&nbsp;</p>\n<p>next\n   line</p>")).toBe(
      "one\ntwo\nthree\n\nnext line",
    );
  });

  it("renders headings by level without doubling a bold title", () => {
    expect(text("<h1>A</h1><h3><strong>B</strong> c</h3><h6>F</h6><h2> </h2>")).toBe("# A\n\n### B c\n\n###### F");
  });

  it("renders links as text + target, and a bare URL once", () => {
    expect(text('<p><a href="https://x.test/a?b=1&amp;c=2">docs</a></p>')).toBe("[docs](https://x.test/a?b=1&c=2)");
    expect(text('<p><a href="https://x.test/">https://x.test/</a> <a href="https://y.test/"></a></p>')).toBe(
      "https://x.test/ https://y.test/",
    );
    expect(text("<p><a>no href</a></p>")).toBe("no href");
  });

  it("renders page, blog, attachment, space, id and anchor links by what they point at", () => {
    const link = (inner: string, attrs = "") => text(`<p><ac:link${attrs}>${inner}</ac:link></p>`);
    expect(link('<ri:page ri:content-title="Release Notes" />')).toBe("[page: Release Notes]");
    expect(link('<ri:page ri:content-title="Release Notes" ri:space-key="DEV" />', ' ac:anchor="v2"')).toBe(
      "[page: Release Notes (space DEV) #v2]",
    );
    // A body equal to the title is not repeated; a different one is the link text.
    expect(
      link('<ri:page ri:content-title="Guide" /><ac:plain-text-link-body><![CDATA[Guide]]></ac:plain-text-link-body>'),
    ).toBe("[page: Guide]");
    expect(link('<ri:page ri:content-title="Guide" /><ac:link-body>the <strong>guide</strong></ac:link-body>')).toBe(
      "[the **guide**](page: Guide)",
    );
    expect(link('<ri:blog-post ri:content-title="Launch" ri:posting-day="2026/01/02" />')).toBe("[blog post: Launch]");
    expect(link('<ri:attachment ri:filename="spec v2.docx" />')).toBe("[attachment: spec v2.docx]");
    expect(link('<ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment>')).toBe(
      "[attachment: a.pdf (on page: Other)]",
    );
    expect(link('<ri:space ri:space-key="OPS" />')).toBe("[space: OPS]");
    expect(link('<ri:content-entity ri:content-id="12345" />')).toBe("[page id: 12345]");
    expect(link("<ac:plain-text-link-body><![CDATA[top]]></ac:plain-text-link-body>", ' ac:anchor="intro"')).toBe(
      "[top](#intro)",
    );
  });

  it("never prints a user key or account id for a mention", () => {
    const key = "ff8080817b0a1b2c017b0a1c3d4e0042";
    const account = "557058:f3a1c9d2-1111-2222-3333-444455556666";
    const out = text(
      `<p>cc <ac:link><ri:user ri:userkey="${key}" /></ac:link>, ` +
        `<ac:link><ri:user ri:account-id="${account}" /></ac:link>, ` +
        `<ac:link><ri:user ri:username="kim.dev" /></ac:link>, ` +
        `<ac:link><ri:user ri:account-id="${account}" /><ac:plain-text-link-body><![CDATA[@Lee Jin]]></ac:plain-text-link-body></ac:link> ` +
        `<ac:structured-macro ac:name="profile"><ac:parameter ac:name="user"><ri:user ri:userkey="${key}" /></ac:parameter></ac:structured-macro></p>`,
    );
    expect(out).toBe("cc [user mention], [user mention], @kim.dev, @Lee Jin [macro profile: user=user mention]");
    expect(out).not.toContain(key);
    expect(out).not.toContain(account);
  });

  it("names images and attachments so get_attachment can fetch them by filename", () => {
    expect(text('<p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image></p>')).toBe("[image: diagram.png]");
    expect(
      text(
        '<p><ac:image ac:title="Flow"><ri:attachment ri:filename="flow.png"><ri:page ri:content-title="Arch" ri:space-key="DEV" /></ri:attachment><ac:caption><p>ignored when a title exists</p></ac:caption></ac:image></p>',
      ),
    ).toBe("[image: flow.png (on page: Arch (space DEV)) — Flow]");
    expect(text('<p><ac:image><ri:url ri:value="https://cdn.test/a.png" /><ac:caption>cap</ac:caption></ac:image></p>')).toBe(
      "[image: https://cdn.test/a.png — cap]",
    );
    expect(text("<p><ac:image /></p>")).toBe("[image]");
    // Plain HTML images: the source, never embedded data.
    expect(text('<p><img src="/download/x.png" alt="shot" /><img src="data:image/png;base64,AAAA" /></p>')).toBe(
      "[image: /download/x.png — shot][image: embedded image data]",
    );
    // A macro that points at an attachment keeps the file name.
    expect(
      text(
        '<ac:structured-macro ac:name="view-file"><ac:parameter ac:name="name"><ri:attachment ri:filename="report.pdf" /></ac:parameter><ac:parameter ac:name="height">250</ac:parameter></ac:structured-macro>',
      ),
    ).toBe("[macro view-file: name=attachment: report.pdf, height=250]");
  });

  it("renders emoticons, dates and placeholders as short text", () => {
    expect(
      text(
        '<p><ac:emoticon ac:name="warning" /> <ac:emoticon ac:name="blue-star" ac:emoji-shortname=":star:" ac:emoji-fallback="⭐" /> due <time datetime="2026-11-30" /> <ac:placeholder>type here</ac:placeholder></p>',
      ),
    ).toBe(":warning: ⭐ due 2026-11-30 [placeholder: type here]");
  });
});

describe("confluence storage → text: lists", () => {
  it("nests ordered and unordered lists by indentation", () => {
    const out = text(
      '<ul><li>a<ol start="3"><li>a1</li><li>a2<ul><li>deep <strong>x</strong></li></ul></li></ol></li><li><p>b</p><p>b second</p></li><li></li></ul>',
    );
    expect(out).toBe(["- a", "  3. a1", "  4. a2", "     - deep **x**", "- b", "  b second"].join("\n"));
  });

  it("renders task lists with their state, including nested tasks", () => {
    const out = text(
      "<ac:task-list>" +
        "<ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>parent" +
        "<ac:task-list><ac:task><ac:task-id>8</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>child</ac:task-body></ac:task></ac:task-list>" +
        "</ac:task-body></ac:task>" +
        "<ac:task><ac:task-status>complete</ac:task-status><ac:task-body><p>done</p></ac:task-body></ac:task>" +
        "</ac:task-list>",
    );
    expect(out).toBe(["- [ ] parent", "      - [x] child", "- [x] done"].join("\n"));
  });

  it("copes with sloppy list markup: unclosed items and a list directly inside a list", () => {
    expect(text("<ul><li>one<li>two<ul><li>x</ul><ul><li>y</li></ul></ul>")).toBe(
      ["- one", "- two", "  - x", "  - y"].join("\n"),
    );
  });
});

describe("confluence storage → text: code and macros", () => {
  it("renders the code macro as a fenced block with its language and title, CDATA taken literally", () => {
    const out = text(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">deploy.sh</ac:parameter><ac:parameter ac:name="language">bash</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter>' +
        "<ac:plain-text-body><![CDATA[\nif [ \"$A\" &lt; 1 ]; then\n\n  echo '<p>&amp;</p>'\nfi\n]]></ac:plain-text-body></ac:structured-macro>",
    );
    expect(out).toBe(["**Code: deploy.sh**", "```bash", 'if [ "$A" &lt; 1 ]; then', "", "  echo '<p>&amp;</p>'", "fi", "```"].join("\n"));
  });

  it("joins a CDATA body split around `]]>` and lengthens the fence past backticks in the code", () => {
    const out = text(
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[a = "]]]]><![CDATA[>"\n```\ninner\n```]]></ac:plain-text-body></ac:structured-macro>',
    );
    expect(out).toBe(["````", 'a = "]]>"', "```", "inner", "```", "````"].join("\n"));
  });

  it("renders noformat and <pre> as plain fenced blocks", () => {
    expect(
      text('<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[x  y\n z]]></ac:plain-text-body></ac:structured-macro>'),
    ).toBe("```\nx  y\n z\n```");
    expect(text("<pre>line 1\n  line 2 &lt;tag&gt;</pre>")).toBe("```\nline 1\n  line 2 <tag>\n```");
  });

  it("labels info/note/warning/tip/panel/expand and keeps their title and body", () => {
    const macro = (name: string, title = "") =>
      `<ac:structured-macro ac:name="${name}">${title ? `<ac:parameter ac:name="title">${title}</ac:parameter>` : ""}<ac:rich-text-body><p>${name} body</p></ac:rich-text-body></ac:structured-macro>`;
    expect(text(macro("info"))).toBe("> **Info**\n>\n> info body");
    expect(text(macro("note", "Read me"))).toBe("> **Note: Read me**\n>\n> note body");
    expect(text(macro("warning"))).toBe("> **Warning**\n>\n> warning body");
    expect(text(macro("tip"))).toBe("> **Tip**\n>\n> tip body");
    expect(text(macro("panel", "Box"))).toBe("> **Panel: Box**\n>\n> panel body");
    expect(text(macro("expand", "Details"))).toBe("> **Expand: Details**\n>\n> expand body");
  });

  it("nests body macros and keeps blocks inside them", () => {
    const out = text(
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body>' +
        "<ul><li>x</li></ul>" +
        '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>inner</p></ac:rich-text-body></ac:structured-macro>' +
        "</ac:rich-text-body></ac:structured-macro>",
    );
    expect(out).toBe(["> **Expand: More**", ">", "> - x", ">", "> > **Note**", "> >", "> > inner"].join("\n"));
  });

  it("treats layout macros as transparent", () => {
    expect(
      text(
        '<ac:structured-macro ac:name="section"><ac:rich-text-body><ac:structured-macro ac:name="column"><ac:parameter ac:name="width">50%</ac:parameter><ac:rich-text-body><p>left</p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>right</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe("left\n\nright");
  });

  it("never drops an unknown macro: name, parameters, plain-text body and rich body all survive", () => {
    expect(text('<ac:structured-macro ac:name="widget-x" />')).toBe("[macro widget-x]");
    expect(
      text(
        '<ac:structured-macro ac:name="include"><ac:parameter ac:name=""><ac:link><ri:page ri:content-title="Shared Header" ri:space-key="TPL" /></ac:link></ac:parameter></ac:structured-macro>',
      ),
    ).toBe("[macro include: page: Shared Header (space TPL)]");
    expect(
      text(
        '<ac:structured-macro ac:name="plantuml"><ac:parameter ac:name="format">svg</ac:parameter><ac:plain-text-body><![CDATA[A -> B: hi]]></ac:plain-text-body></ac:structured-macro>',
      ),
    ).toBe(["> **Macro plantuml** (format=svg)", ">", "> ```", "> A -> B: hi", "> ```"].join("\n"));
    expect(
      text(
        '<ac:structured-macro ac:name="ui-tab"><ac:parameter ac:name="title">Linux</ac:parameter><ac:rich-text-body><p>apt install</p></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe(["> **Macro ui-tab** (title=Linux)", ">", "> apt install"].join("\n"));
    // The pre-4.0 macro element with a default parameter.
    expect(text('<ac:macro ac:name="anchor"><ac:default-parameter>top</ac:default-parameter></ac:macro>')).toBe(
      "[macro anchor: top]",
    );
    // Many long parameters stay bounded.
    const many = Array.from({ length: 12 }, (_, i) => `<ac:parameter ac:name="p${i}">${"v".repeat(300)}</ac:parameter>`).join("");
    const bounded = text(`<ac:structured-macro ac:name="big">${many}</ac:structured-macro>`);
    expect(bounded).toContain("+4 more");
    expect(bounded.length).toBeLessThan(1_200);
  });

  it("names status, jira and drawio macros by what matters", () => {
    expect(
      text(
        '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Red</ac:parameter></ac:structured-macro> ' +
          '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="server">JIRA</ac:parameter><ac:parameter ac:name="key">OPS-42</ac:parameter></ac:structured-macro> ' +
          '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="jqlQuery">project = OPS</ac:parameter></ac:structured-macro></p>' +
          '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="border">true</ac:parameter><ac:parameter ac:name="diagramName">network.drawio</ac:parameter></ac:structured-macro>',
      ),
    ).toBe("[status: Red] [jira: OPS-42] [jira query: project = OPS]\n\n[drawio diagram: network.drawio]");
  });

  it("renders a Cloud ADF panel from its content, not twice from the fallback", () => {
    const out = text(
      '<ac:adf-extension><ac:adf-node type="panel"><ac:adf-attribute key="panel-type">note</ac:adf-attribute><ac:adf-content><p>adf body</p></ac:adf-content></ac:adf-node><ac:adf-fallback><div class="panel"><p>adf body</p></div></ac:adf-fallback></ac:adf-extension>',
    );
    expect(out).toBe("> **panel: note**\n>\n> adf body");
  });
});

describe("confluence storage → text: tables", () => {
  it("renders a header row and body rows, flattening markup inside cells", () => {
    const out = text(
      "<table><thead><tr><th><p><strong>Name</strong></p></th><th>Notes</th></tr></thead><tbody>" +
        '<tr><td><p>api</p><p>v2</p></td><td><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">sh</ac:parameter><ac:plain-text-body><![CDATA[curl a | jq .]]></ac:plain-text-body></ac:structured-macro></td></tr>' +
        '<tr><td><ac:structured-macro ac:name="info"><ac:rich-text-body><p>in a cell</p></ac:rich-text-body></ac:structured-macro></td><td><ac:image><ri:attachment ri:filename="c.png" /></ac:image></td></tr>' +
        "</tbody></table>",
    );
    expect(out).toBe(
      [
        "| Name | Notes |",
        "| --- | --- |",
        "| api ⏎ v2 | ```sh ⏎ curl a \\| jq . ⏎ ``` |",
        "| **Info** ⏎ in a cell | [image: c.png] |",
      ].join("\n"),
    );
  });

  it("gives a header-less table an empty header and marks row headers bold", () => {
    expect(text("<table><tbody><tr><th>Owner</th><td>ops</td></tr><tr><th>SLA</th><td>99.9</td></tr></tbody></table>")).toBe(
      ["| Owner | ops |", "| --- | --- |", "| **SLA** | 99.9 |"].join("\n"),
    );
    expect(text("<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>")).toBe(
      ["|  |  |", "| --- | --- |", "| 1 | 2 |", "| 3 |  |"].join("\n"),
    );
  });

  it("degrades merged cells to an aligned grid with markers and a legend", () => {
    const out = text(
      "<table><tbody>" +
        '<tr><th>Team</th><th colspan="2">Contact</th></tr>' +
        '<tr><td rowspan="2">Ops</td><td>mail</td><td>ops@x.test</td></tr>' +
        "<tr><td>pager</td><td>1234</td></tr>" +
        "</tbody></table>",
    );
    expect(out).toBe(
      [
        "| Team | Contact | (←) |",
        "| --- | --- | --- |",
        "| Ops | mail | ops@x.test |",
        "| (↑) | pager | 1234 |",
        "",
        "(merged cells: (←) continues the cell to its left, (↑) the cell above)",
      ].join("\n"),
    );
  });

  it("keeps a nested table inside its cell and bounds hostile spans", () => {
    const nested = text("<table><tr><td>outer<table><tr><td>in1</td><td>in2</td></tr></table></td><td>z</td></tr></table>");
    expect(nested.split("\n")).toHaveLength(3);
    expect(nested).toContain("outer ⏎ \\|  \\|  \\| ⏎ \\| --- \\| --- \\| ⏎ \\| in1 \\| in2 \\| | z |");

    const hostile = text('<table><tr><td colspan="999999999" rowspan="999999999">x</td></tr><tr><td>y</td></tr></table>');
    const lines = hostile.split("\n");
    expect(lines[0]!.split("|").length - 2).toBe(60); // capped column count
    expect(hostile.length).toBeLessThan(2_000);
  });
});

describe("confluence storage → text: entities, CDATA and untrusted markup", () => {
  it("decodes entities exactly once", () => {
    expect(decodeXmlEntities("&amp;lt;b&amp;gt; &lt;i&gt; &#65;&#x42; &nbsp;|&rarr;&hellip;&yuml;&times;&euro;")).toBe(
      "&lt;b&gt; <i> AB  |→…ÿ×€",
    );
    // Unknown names stay as written; out-of-range and surrogate references never throw.
    expect(decodeXmlEntities("&bogus; &#x110000; &#xD800; &#0; &#99999999;")).toBe("&bogus; � � � �");
    expect(text("<p>1 &lt; 2 &amp;&amp; x &amp;lt; y &mdash; ok</p>")).toBe("1 < 2 && x &lt; y — ok");
    // Attribute values are decoded too.
    expect(text('<p><ac:image><ri:attachment ri:filename="a &amp; b &lt;1&gt;.png" /></ac:image></p>')).toBe(
      "[image: a & b <1>.png]",
    );
  });

  it("lets no markup through: scripts, styles, comments, event handlers and unknown tags", () => {
    const out = text(
      '<p onclick="steal()">hello <script>alert("x")</script><style>p{color:red}</style><!-- hidden <b>note</b> -->' +
        '<blink class="x">world</blink> <iframe src="https://evil.test/">frame text</iframe><object data="x"><embed src="y" /></object></p>' +
        "<custom:block><p>kept</p></custom:block>",
    );
    expect(out).toBe("hello world frame text\n\nkept");
  });

  it("treats page text that looks like instructions or markup as plain text", () => {
    // Escaped markup in the page is TEXT the author typed; it comes back as text, once.
    expect(text("<p>write &lt;script&gt;alert(1)&lt;/script&gt; in the doc</p>")).toBe(
      "write <script>alert(1)</script> in the doc",
    );
    expect(text("<p>if a < b and c > d then <strong>stop</strong></p>")).toBe("if a < b and c > d then **stop**");
  });
});

describe("confluence storage → text: malformed input", () => {
  it("returns best-effort text for unbalanced, unclosed and stray markup", () => {
    expect(text("<p>one</p></div></p><p>two")).toBe("one\n\ntwo");
    expect(text("<p><strong>bold <em>both</p><p>next</p>")).toBe("**bold *both***\n\nnext");
    expect(text("<ul><li>a</li></ol><li>b</li></ul>trailing")).toBe("- a\n- b\n\ntrailing");
    expect(text("text <")).toBe("text <");
    expect(text("a <b")).toBe("a <b");
    expect(text('<p>x <a href="https://t.test>broken</a> y</p>')).toContain("y");
    expect(text("<p>before <![CDATA[never closed <b>raw</b>")).toBe("before never closed <b>raw</b>");
    // An unterminated comment loses only its opener: the text after it is kept, not swallowed.
    expect(text("<p>a <!-- never closed <strong>b</strong></p>")).toBe("a never closed **b**");
    expect(text("<<<>>> <p>ok</p> </>")).toContain("ok");
    expect(text('<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x = 1')).toBe("```\nx = 1\n```");
    expect(text("<table><tr><td>a<td>b</table>")).toBe("|  |  |\n| --- | --- |\n| a | b |");
    expect(text("<?xml version=\"1.0\"?><!DOCTYPE html><p>doc</p>")).toBe("doc");
    expect(text("<p>ctrl\u0000\u0007 chars​</p>")).toBe("ctrl chars");
  });

  it("flattens absurdly deep nesting instead of overflowing the stack", () => {
    const depth = 20_000;
    const out = text(`${"<div><ul><li>".repeat(depth)}core${"</li></ul></div>".repeat(depth)}<p>after</p>`);
    expect(out).toContain("core");
    expect(out).toContain("after");
    expect(text(`${"<strong>".repeat(50_000)}deep`)).toContain("deep");
  });

  it("stays linear on hostile input", () => {
    const started = Date.now();
    expect(typeof text("<".repeat(300_000))).toBe("string");
    expect(typeof text('<a "'.repeat(100_000))).toBe("string");
    expect(typeof text("<!--".repeat(100_000))).toBe("string");
    expect(typeof text(`<p>${"<span> </span>".repeat(50_000)}<br/>x</p>`)).toBe("string");
    expect(typeof text(`<p>${"<br/>".repeat(100_000)}<strong>x</strong></p>`)).toBe("string");
    expect(typeof text(`<p>${"&amp;".repeat(100_000)}</p>`)).toBe("string");
    // Quadratic handling of any of these would take minutes, not seconds.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("never throws on random markup soup", () => {
    const pieces = [
      "<p>", "</p>", "<ul>", "</ul>", "<li>", "</li>", "<table>", "<tr>", "<td colspan='3'>", "</td>", "</table>",
      "<ac:structured-macro ac:name=\"code\">", "<ac:plain-text-body>", "<![CDATA[", "]]>", "</ac:structured-macro>",
      "<ac:rich-text-body>", "</ac:rich-text-body>", "<ac:link>", "<ri:user ri:userkey='k' />", "</ac:link>",
      "<ac:image>", "<ri:attachment ri:filename=\"f.png\"/>", "<strong>", "</em>", "<br>", "&amp;", "&#xZZ;", "&#99999999;",
      "<!--", "-->", "<", ">", "\"", "'", "text ", "한글 ", "\n", "<ac:task-list>", "<ac:task>", "<h2>", "</h7>", "<a href=", "|",
    ];
    let seed = 20261111;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let round = 0; round < 400; round += 1) {
      let soup = "";
      const count = 5 + (next() % 60);
      for (let i = 0; i < count; i += 1) soup += pieces[next() % pieces.length];
      let out: unknown;
      expect(() => {
        out = text(soup);
      }, soup).not.toThrow();
      expect(typeof out).toBe("string");
    }
  });
});

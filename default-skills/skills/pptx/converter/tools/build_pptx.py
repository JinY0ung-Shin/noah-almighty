#!/usr/bin/env python3
"""IR -> native, editable PPTX (docs/CONTRACT.md "IR" + "v2 decisions"). Normally run by tools/deck.mjs.

    python3 tools/build_pptx.py --ir <deck>/.build/<p>/ir.json --profile <p> --out <deck>/.build/<p>/deck.pptx
                                [--author NAME] [--map <deck>/.build/<p>/deck.map.json]

* 16:9 deck from python-pptx's default template, sanitized (no kern thresholds, 16:9 sldSz, theme fonts = the
  profile's regular typeface, theme colours = the IR's ``theme.colors``; its 11 stock layouts, English master prompts,
  theme name and printer settings removed or replaced at the end, J2-02); custom slide layouts per slide family
  (pptxlib/layouts.py: background, repeated chrome, title prompt placeholder; the master gets the main background);
  one slide per IR slide on its layout; elements in paint order (shape / text / image / table / chart; a table's
  own background shape is absorbed into the table); the slide title as a title placeholder; components grouped
  (pptxlib/structure.py); speaker notes; readable object names; document properties + thumbnail
  (pptxlib/docprops.py); ``<out stem>.map.json`` = every object's p:cNvPr id -> IR id (the fidelity gate's link);
* charts: ``from pptxlib.chart import add_chart`` (chart lane) called as ``add_chart(slide, el, ctx)`` with
  ``ctx.profile`` (fonts.json profile dict), ``ctx.resolve_face(css_weight) -> {"typeface", "bold"}``,
  ``ctx.emu(px) -> int``, ``ctx.poc`` (Path of the toolkit, KIT); a missing module is a warning and the chart is
  skipped;
* when the profile embeds, ``tools/embed_fonts.embed_fonts`` runs LAST on the saved deck.

Exit status: 0 = deck written (warnings possible), 1 = fatal error (nothing written), 2 = --strict and warnings.
All IR paths are relative to the directory of --ir (the IR directory); fonts.json paths are relative to KIT (the
converter toolkit); --ir/--out are relative to the current directory. The Noah port dropped the PoC's overlay
review deck (a full-slide overlay picture captures clicks and prints).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from pptx.oxml.ns import qn  # noqa: E402

from pptxlib import core, docprops, fonts, layouts, pictures, shapes, structure, table, text  # noqa: E402
import pdeathsig  # noqa: E402  (tools/pdeathsig.py)

KIT = core.KIT
POC = KIT                                            # PoC name, kept as an alias


class ChartContext:
    """The interface the chart lane codes against (keep: profile, resolve_face, emu, poc = KIT)."""

    def __init__(self, prof: fonts.Profile, log: core.Log):
        self.profile = prof.data                      # the fonts.json profile dict
        self.resolve_face = prof.resolve_face         # css_weight -> {"typeface": str, "bold": bool}
        self.emu = core.emu                           # px -> EMU int
        self.poc = KIT                                # pathlib.Path of the toolkit (the PoC's $POC)
        self.profile_name = prof.name                 # extras (optional for the chart lane)
        self.warn = log.warn


class BuildContext:
    def __init__(self, prof: fonts.Profile, log: core.Log, ir_dir: Path):
        self.prof = prof
        self.log = log
        self.ir_dir = Path(ir_dir)                    # IR paths (image src/svg) resolve against it
        self.chart_ctx = ChartContext(prof, log)
        self.namer = core.Namer()
        self.slide_index = 0
        self.stats: dict[str, int] = {}

    @staticmethod
    def name_for(e: dict, role: str = "main") -> str:
        """Readable Selection Pane name (the DOM path is kept in the map file)."""
        return structure.object_name(e, role)

    def stat(self, key: str, n: int = 1) -> None:
        self.stats[key] = self.stats.get(key, 0) + n


_chart_fn = None
_chart_import_failed = False


def _load_chart(log):
    global _chart_fn, _chart_import_failed
    if _chart_fn is None and not _chart_import_failed:
        try:
            from pptxlib.chart import add_chart  # chart lane (tools/pptxlib/chart.py)
            _chart_fn = add_chart
        except Exception as exc:  # noqa: BLE001 — ImportError or an error inside the module
            _chart_import_failed = True
            log.warn(f"chart module unavailable ({type(exc).__name__}: {exc}); charts are skipped")
    return _chart_fn


def add_chart_element(slide, e, ctx):
    fn = _load_chart(ctx.log)
    if fn is None:
        ctx.log.skip(f"slide {ctx.slide_index}: chart {e.get('id')!r} skipped (no chart module)")
        return
    tree = slide.shapes._spTree
    before = set(tree)
    fn(slide, e, ctx.chart_ctx)
    for node in tree:
        if node in before or not isinstance(node.tag, str):
            continue
        c = node.find(".//" + qn("p:cNvPr"))
        if c is not None and (not c.get("name") or c.get("name", "").startswith("Chart ")):
            c.set("name", ctx.namer(ctx.name_for(e)))
        if c is not None and not c.get("descr"):     # alt text: kind, categories, series values (J2-03)
            c.set("descr", structure.chart_alt_text(e.get("spec") or {}, e.get("resolved")))
    ctx.stats["chart"] = ctx.stats.get("chart", 0) + 1


def set_notes(slide, notes, ctx) -> None:
    if not isinstance(notes, str) or not notes.strip():
        return
    tf = slide.notes_slide.notes_text_frame
    tx = tf._txBody
    for p in tx.findall(qn("a:p")):
        tx.remove(p)
    face = ctx.prof.regular
    for line in text._LINE_SEP.split(notes.strip("\n")):
        ap = core.sub(tx, "a:p")
        t = text.clean_text(line)
        rpr_attrs = dict(lang="ko-KR", altLang="en-US", dirty="0")
        if t:
            r = core.sub(ap, "a:r")
            rpr = core.sub(r, "a:rPr", **rpr_attrs)
            for slot in ("a:latin", "a:ea", "a:cs"):
                core.sub(rpr, slot, typeface=face.typeface)
            core.sub(r, "a:t").text = t
        end = core.sub(ap, "a:endParaRPr", **rpr_attrs)
        for slot in ("a:latin", "a:ea", "a:cs"):
            core.sub(end, slot, typeface=face.typeface)


def _title_of(s: dict) -> str:
    for e in s.get("elements") or []:
        if isinstance(e, dict) and e.get("kind") == "text" and e.get("placeholder") in ("title", "ctrTitle"):
            return " ".join(structure.text_of(e).split())
    return ""


def _counts(ir: dict) -> tuple[int, int]:
    words = paras = 0
    for s in ir.get("slides") or []:
        if not isinstance(s, dict):
            continue
        for e in s.get("elements") or []:
            if not isinstance(e, dict):
                continue
            ps = []
            if e.get("kind") == "text":
                ps = e.get("paragraphs") or []
            elif e.get("kind") == "table":
                ps = [p for row in e.get("cells") or [] if isinstance(row, list) for c in row
                      if isinstance(c, dict) and not c.get("covered") for p in c.get("paragraphs") or []]
            for p in ps:
                if not isinstance(p, dict):
                    continue
                t = structure.text_of({"paragraphs": [p]})
                if t.strip():
                    paras += 1
                    words += len(t.split())
    return words, paras


def _emit(slide, e, ctx, handler, **kw) -> list:
    """Run one element handler; returns the top-level nodes it added (a failure is a skip, never a lost deck)."""
    tree = slide.shapes._spTree

    def run():
        try:
            handler(slide, e, ctx, **kw)
        except Exception as exc:  # noqa: BLE001 — one bad element must not lose the deck
            ctx.log.skip(f"slide {ctx.slide_index}: {e.get('kind')} {e.get('id')!r} failed: {type(exc).__name__}: {exc}")
            if os.environ.get("BUILD_PPTX_TRACEBACK"):
                traceback.print_exc()
    return structure.capture(tree, run)


def build(ir: dict, profile_name: str, out_path: Path, *, ir_dir: Path, log: core.Log | None = None,
          fonts_json: Path | None = None, author: str = "Noah Almighty", map_path: Path | None = None,
          ir_path: str | None = None) -> dict:
    log = log or core.Log()
    prof = fonts.load_profile(profile_name, fonts_json, log)
    if ir.get("profile") and ir["profile"] != profile_name:
        log.warn(f"IR was extracted for profile {ir['profile']!r} but building for {profile_name!r}")
    sz = ir.get("slideSizePx") or {}
    if sz and (core.num(sz.get("w"), 1280) != 1280 or core.num(sz.get("h"), 720) != 720):
        log.warn(f"IR slideSizePx {sz} != 1280x720; coordinates are used as-is")
    lint = ir.get("lint") or []
    if lint:
        errs = sum(1 for x in lint if isinstance(x, dict) and x.get("severity") == "error")
        log.info(f"IR lint: {errs} error(s), {len(lint) - errs} warning(s) reported by the extractor")

    prs = core.new_presentation(prof.regular.typeface)
    slides_ir = [s for s in ir.get("slides") or [] if isinstance(s, dict)]
    deck_title = next((t for t in (_title_of(s) for s in slides_ir) if t), "")
    ctx = BuildContext(prof, log, ir_dir)
    n_theme = core.set_theme_colors(prs, (ir.get("theme") or {}).get("colors"), name=deck_title or None)
    if n_theme:
        ctx.stat("theme:colors", n_theme)
    handlers = {"shape": shapes.add_shape, "text": text.add_text, "image": pictures.add_image,
                "table": table.add_table, "chart": add_chart_element}

    # ---- slide layouts: one per slide family (background, chrome, title prompt)
    plans = layouts.plan_layouts(slides_ir)
    plan_of = {}
    for pl in plans:
        pl.layout = layouts.create_layout(prs, pl.name)
        shapes.set_background(pl.layout, pl.background, log.warn)
        pl.namer = core.Namer()
        for i in pl.slides:
            plan_of[i] = pl
        ctx.stat("layout")
        if pl.chrome:
            ctx.stat("layout:chrome", len(pl.chrome))
    if plans:
        main_plan = max(plans, key=lambda p_: len(p_.slides))
        shapes.set_background(prs.slide_masters[0], main_plan.background, log.warn)

    map_parts = []
    notes_theme_done = False
    for si, s in enumerate(slides_ir):
        pl = plan_of[si]
        first_of_family = pl.slides[0] == si
        ctx.slide_index = s.get("index", si + 1)
        ctx.namer = core.Namer()
        slide = prs.slides.add_slide(pl.layout)
        for ph in list(slide.placeholders):          # the layout's prompt placeholders are cloned: not ours
            ph._element.getparent().remove(ph._element)
        if not layouts.same_background(s.get("background"), pl.background):
            shapes.set_background(slide, s.get("background"), log.warn)
        elif layouts.is_dark_background(s.get("background")):
            shapes.set_background(slide, s.get("background"), log.warn)   # light text depends on it (EDIT-05)
            ctx.stat("background:pinned-dark")
        else:
            ctx.stat("background:inherited")
        tree = slide.shapes._spTree
        skip = set() if first_of_family else pl.chrome_set
        elements = [e for e in s.get("elements") or [] if isinstance(e, dict)]
        recs, split_comps, ph_recs = [], [], []
        k = 0
        while k < len(elements):
            e = elements[k]
            k += 1
            if e.get("id") in skip:
                continue
            kind = e.get("kind")
            h = handlers.get(kind)
            if h is None:
                log.skip(f"slide {ctx.slide_index}: unknown element kind {kind!r} ({e.get('id')!r}) — skipped")
                continue
            nxt = elements[k] if k < len(elements) else None
            if kind == "shape" and table.table_bg_of(e, nxt) is not None and nxt.get("id") not in skip:
                k += 1                                   # the table's own background goes INTO the table (J1-01)
                nodes = _emit(slide, nxt, ctx, table.add_table, table_bg=e)
                for n in nodes:
                    recs.append(structure.Rec(nxt.get("id"), "table", "main", n))
                    recs.append(structure.Rec(e.get("id"), "shape", "table-bg", n))
                continue
            nodes = _emit(slide, e, ctx, h)
            roles = ["fill", "border"] if kind == "shape" and len(nodes) == 2 else ["main"] * len(nodes)
            for n, role in zip(nodes, roles):
                recs.append(structure.Rec(e.get("id"), kind, role, n))
                if kind == "text" and e.get("placeholder"):
                    ph_recs.append((e["placeholder"], n))
            if len(nodes) > 1:                           # one CSS box written as several shapes: one group
                split_comps.append({"id": e.get("id"), "name": ctx.name_for(e), "members": [e.get("id")]})
        if first_of_family:
            done = set()
            for ph_type, node in ph_recs:                # the family's title style for slides added in PowerPoint
                if ph_type not in done:
                    layouts.add_prompt_placeholder(pl, node, ph_type, pl.namer)
                    done.add(ph_type)
            if pl.chrome:
                recs = layouts.lift_chrome(pl, recs, log)
        comps = split_comps + [c for c in s.get("components") or [] if isinstance(c, dict)]
        n_groups = structure.group_components(tree, recs, comps, ctx.namer, log, f"slide {ctx.slide_index}")
        if n_groups:
            ctx.stat("group", n_groups)
        set_notes(slide, s.get("notes"), ctx)
        if isinstance(s.get("notes"), str) and s["notes"].strip() and not notes_theme_done:
            core.sanitize_notes_master(prs, prof.regular.typeface)      # created lazily by the first notes slide
            notes_theme_done = True
        n = core.fix_shape_ids(slide)
        if n:
            log.warn(f"slide {ctx.slide_index}: renumbered {n} duplicate/invalid shape id(s)")
        map_parts.append({"part": str(slide.part.partname).lstrip("/"), "kind": "slide", "slide": ctx.slide_index,
                          "layout": pl.name, "layoutPart": str(pl.layout.part.partname).lstrip("/"),
                          "background": "own" if slide._element.cSld.bg is not None else "layout",
                          "records": recs})

    for pl in plans:
        ltree = layouts.layout_tree(pl.layout)
        if pl.chrome:
            first = slides_ir[pl.slides[0]]
            comps = [c for c in first.get("components") or [] if isinstance(c, dict)]
            n_groups = structure.group_components(ltree, pl.records, comps, pl.namer, log, f"layout {pl.name!r}")
            if n_groups:
                ctx.stat("group", n_groups)
        n = core.fix_shape_ids(pl.layout)
        if n:
            log.warn(f"layout {pl.name!r}: renumbered {n} duplicate/invalid shape id(s)")
        map_parts.append({"part": str(pl.layout.part.partname).lstrip("/"), "kind": "layout", "name": pl.name,
                          "slides": [slides_ir[i].get("index", i + 1) for i in pl.slides], "records": pl.records})

    if core.ensure_notes_master_listed(prs):         # python-pptx relates the lazily created notes master, never lists it
        ctx.stat("notes:master-listed")
    # ---- template residue (J2-02): only the deck's own layouts, Korean master prompts, the theme named after the deck
    n_pruned = layouts.prune_template(prs, deck_title or None)
    if n_pruned:
        ctx.stat("layout:pruned", n_pruned)

    # ---- package metadata (J1-08)
    when = docprops.build_time()
    docprops.set_core(prs, title=deck_title, author=author, when=when)
    words, paras = _counts(ir)
    titles = [_title_of(s) or f"슬라이드 {s.get('index', i + 1)}" for i, s in enumerate(slides_ir)]
    theme_name = "Office Theme"
    try:
        from lxml import etree as _et
        tp = prs.slide_masters[0].part.part_related_by(core.RT.THEME)
        theme_name = _et.fromstring(tp.blob).get("name") or theme_name
    except Exception:  # noqa: BLE001
        pass
    docprops.set_app(prs, slides=len(prs.slides), notes=sum(1 for sl in prs.slides if sl.has_notes_slide),
                     hidden=0, words=words, paragraphs=paras, theme=theme_name, titles=titles,
                     application="Noah Almighty")
    ref0 = slides_ir[0].get("referencePng") if slides_ir else None
    if ref0 and docprops.set_thumbnail(prs, core.resolve_path(ref0, ir_dir)):
        ctx.stat("thumbnail")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".pptx", dir=str(out_path.parent), prefix=".build-")
    os.close(fd)
    try:
        prs.save(tmp)
        if prof.embed:
            from embed_fonts import EmbedError, embed_fonts   # tools/embed_fonts.py — always the LAST step
            try:
                embed_fonts(tmp, tmp, prof.embed_faces(), log=lambda m: log.info(f"embed_fonts: {m}"))
            except EmbedError as exc:
                raise RuntimeError(f"font embedding failed: {exc}") from exc
        um = os.umask(0)
        os.umask(um)
        os.chmod(tmp, 0o666 & ~um)                 # mkstemp creates 0600; a normal output file follows the umask
        os.replace(tmp, out_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    mp = map_path or out_path.with_suffix(".map.json")
    structure.write_map(mp, out_path, ir_path, map_parts)
    return {"out": str(out_path), "map": str(mp), "slides": len(prs.slides), "stats": ctx.stats,
            "warnings": len(log.warnings), "skipped": len(log.skipped)}


def main(argv=None) -> int:
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description="Build a native, editable PPTX from the extractor's IR.")
    ap.add_argument("--ir", required=True, help="IR JSON (<deck>/.build/<profile>/ir.json)")
    ap.add_argument("--profile", required=True, help="fonts.json profile (embedded | malgun)")
    ap.add_argument("--out", required=True, help="output .pptx")
    ap.add_argument("--fonts-json", help="default: <KIT>/fonts/fonts.json")
    ap.add_argument("--author", default="Noah Almighty", help="docProps creator/lastModifiedBy (the Noah user)")
    ap.add_argument("--map", help="IR <-> PPTX object map (default: <out without .pptx>.map.json)")
    ap.add_argument("--strict", action="store_true", help="exit 2 when any warning was issued")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)
    log = core.Log(quiet=args.quiet)
    try:
        ir = json.loads(Path(args.ir).read_text(encoding="utf-8"))
        rep = build(ir, args.profile, Path(args.out), ir_dir=Path(args.ir).resolve().parent, log=log,
                    fonts_json=Path(args.fonts_json) if args.fonts_json else None, author=args.author,
                    map_path=Path(args.map) if args.map else None, ir_path=args.ir)
    except Exception as exc:  # noqa: BLE001
        print(f"build_pptx: error: {type(exc).__name__}: {exc}", file=sys.stderr)
        if os.environ.get("BUILD_PPTX_TRACEBACK"):
            traceback.print_exc()
        return 1
    print(json.dumps(rep, ensure_ascii=False))
    return 2 if args.strict and log.warnings else 0


if __name__ == "__main__":
    sys.exit(main())

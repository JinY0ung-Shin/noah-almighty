// `deck.mjs probe`: the toolchain state as facts (docs/CONTRACT.md "Probe"). Never launches a browser (~0.3 s):
// Chromium `--version`, playwright-core's package.json, one Python find_spec round, file existence, the build-time
// self-test record. The server's boot probe (src/server/deckRender.ts) runs this with --json.
import { VERSION, limitsFromEnv } from './deckfs.mjs';
import { toolchainFacts } from './toolchain.mjs';

export function probe(env = process.env) {
  const f = toolchainFacts(env, { withVersion: true });
  const converter = f.missing.length === 0;
  return {
    format: 'noah-deck-probe', version: 1, converter, converterVersion: VERSION,
    chromium: f.chromium,
    playwrightCore: f.playwrightCore,
    python: { ok: f.python.ok, executable: f.python.executable, version: f.python.version, missingModules: f.python.missingModules || [] },
    fonts: f.fonts,
    profiles: converter ? ['embedded', 'malgun'] : [],
    limits: limitsFromEnv(env),
    selftest: f.record,
    missing: f.missing,
  };
}

export function probeLines(p) {
  const ok = (b) => (b ? 'OK  ' : 'MISSING');
  const L = [`deck converter probe: converter ${p.converter ? 'INSTALLED' : 'NOT INSTALLED'} (noah-pptx-converter ${p.converterVersion})`];
  L.push(`  chromium    ${ok(p.chromium.ok)}  ${p.chromium.version || '-'}  ${p.chromium.path || '-'}${p.chromium.source ? ` (${p.chromium.source})` : ''}`);
  L.push(`  playwright  ${ok(p.playwrightCore.ok)}  ${p.playwrightCore.version || '-'}`);
  L.push(`  python      ${ok(p.python.ok)}  ${p.python.version || '-'} (${p.python.executable})${p.python.missingModules.length ? `; missing modules: ${p.python.missingModules.join(', ')}` : ''}`);
  L.push(`  fonts       embedded ${p.fonts.embedded ? 'ok' : 'MISSING'}, malgun ${p.fonts.malgun ? 'ok' : 'MISSING'}`);
  const l = p.limits;
  L.push(`  limits      ${l.maxSlides} slides, ${l.maxSeconds} s per run, ${l.maxConcurrent} concurrent (slot wait ${l.slotWaitSeconds} s), slide HTML ${l.maxSlideHtmlBytes / 1048576} MB, ${l.maxDomElements} elements, files ${l.maxAssetBytes / 1048576} MB, inputs ${l.maxDeckInputBytes / 1048576} MB, pictures ${l.maxImagePixels / 1e6} MP each / ${l.maxSlideImagePixels / 1e6} MP per slide`);
  const s = p.selftest;
  // the image build's self-test record: facts for a maintainer — nothing here asks the agent to act
  const about = {
    pass: 'the image build verified the converter',
    drift: 'reference renders drifted at image build; decks still pass every integrity gate (a maintainer note)',
    disabled: 'the image was built without the converter',
    'not-recorded': 'no image-build record, normal outside the server image',
  }[s.status];
  L.push(`  selftest    ${s.status}${s.chromiumVersion ? ` (Chromium ${s.chromiumVersion}${s.at ? `, ${s.at}` : ''})` : ''}${about ? ` — informational, no action needed: ${about}` : ''}`);
  for (const m of p.missing) L.push(`  missing: ${m}`);
  return L;
}

# Open XML SDK validator (dev/CI only)

A small console program around Microsoft's Open XML SDK `OpenXmlValidator`
(`DocumentFormat.OpenXml` **3.3.0**, `FileFormatVersions.Microsoft365`, .NET 8). It validates a `.pptx`
against the schemas and semantic constraints the SDK models — a validation error is a repair-prompt
risk in PowerPoint. The converter's opt-in e2e (`tests/deck-converter.test.ts`) runs it over the photo-slot
decks when `NOAH_OPENXML_VALIDATOR_DLL` and `dotnet` exist; the retired Noah-image Docker smoke used to run it
over every produced deck (porting that to `docker/pi-sandbox/verify.sh` is backlog PC3).

It is **not** part of the Noah image (there is no .NET in it) and never runs at request time; the
converter's runtime gates are the Python checks under `default-skills/skills/pptx/converter/tools/gates/`.
Mechanics: [`docs/architecture/pptx-converter.md`](../../docs/architecture/pptx-converter.md).

Provenance: `Program.cs` and `Validator.csproj` are vendored verbatim from the HTML→PPTX proof of concept
(`scratch/text-mapping/validator/` and `scratch/shape-table/validator/` there — the two copies were
byte-identical). Nothing else is vendored: the PoC's `bin/`, `obj/`, `out/` and NuGet cache were build
output.

## Usage

```
dotnet Validator.dll <deck.pptx> [<deck.pptx> ...]
```

Per file it prints `FILE <path>: <n> error(s)`, followed by up to 50 lines
`[<ErrorType>] <part uri> <xpath> :: <description>`. Exit code: `0` every file is clean, `1` at least one
validation error, `2` a file could not be opened as a presentation.

## Build (outside the repository)

`dotnet` writes `obj/` next to the `.csproj` even when publishing elsewhere, so build a COPY (the
`.gitignore` / `.dockerignore` rules for `bin/` and `obj/` here are only a safety net):

```bash
d="$(mktemp -d)"
cp scripts/openxml-validator/Program.cs scripts/openxml-validator/Validator.csproj "$d"/
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -v "$d:/src" -w /src mcr.microsoft.com/dotnet/sdk:8.0 dotnet publish -c Release -o /src/out
# -> "$d/out/Validator.dll" (framework-dependent; keep the whole out/ dir together)

docker run --rm --network none -u "$(id -u):$(id -g)" -e HOME=/tmp -e DOTNET_CLI_TELEMETRY_OPTOUT=1 \
  -v "$d/out:/validator:ro" -v "$PWD:/work:ro" mcr.microsoft.com/dotnet/sdk:8.0 \
  dotnet /validator/Validator.dll /work/path/to/deck.pptx
```

The restore step needs NuGet (`api.nuget.org`, or a NuGet mirror configured for the SDK image).

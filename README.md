# tldraw-ocif

[OCIF (Open Canvas Interchange Format)](https://github.com/ocwg/spec) plugin for [tldraw](https://tldraw.dev) — import and export canvases using the OCWG specification.

> **Status**: Implements OCIF v0.7.0

## Install

```bash
npm install tldraw-ocif tldraw
```

`tldraw` is a **peer dependency** — make sure it's installed in your project.

## Quick start

### Export a tldraw canvas to OCIF

```ts
import { serializeTldrawToOcif } from 'tldraw-ocif'

// `editor` is a tldraw Editor instance
const ocifJson = await serializeTldrawToOcif(editor)

// Download as file
const blob = new Blob([ocifJson], { type: 'application/vnd.ocif+json' })
const url = URL.createObjectURL(blob)
const a = document.createElement('a')
a.href = url
a.download = 'canvas.ocif.json'
a.click()
```

### Import an OCIF file into tldraw

```ts
import { parseAndLoadOcifFile } from 'tldraw-ocif'

const ocifContent = await file.text()
await parseAndLoadOcifFile(editor, ocifContent, msg, addToast)
```

### Parse an OCIF file without loading (headless)

```ts
import { parseOcifFile } from 'tldraw-ocif'
import { createTLSchema } from 'tldraw'

const schema = createTLSchema()
const result = parseOcifFile({ json: ocifContent, schema })

if (result.ok) {
  const store = result.value
  const records = store.allRecords()
  // work with records...
}
```

## API

| Export | Description |
| --- | --- |
| `serializeTldrawToOcif(editor)` | Export the current page to an OCIF v0.7.0 JSON string |
| `serializeTldrawToOcifBlob(editor)` | Export to a `Blob` with the correct MIME type |
| `parseOcifFile({ json, schema })` | Parse OCIF JSON → `Result<TLStore, OcifFileParseError>` |
| `parseAndLoadOcifFile(editor, json, msg, addToast)` | Parse and load OCIF directly into a tldraw editor |
| `OCIF_FILE_MIMETYPE` | `'application/vnd.ocif+json'` |
| `OCIF_FILE_EXTENSION` | `'.ocif.json'` |

### Types

```ts
OcifFile
OcifNode
OcifResource
OcifRepresentation
OcifSchema
OcifFileParseError
```

## Supported OCIF features

### Shapes (OCIF v0.7.0)

- `@ocif/rect` — rectangles (and geo variants like diamond, star, triangle, etc.)
- `@ocif/oval` — ellipses / circles
- `@ocif/path` — SVG paths / freehand drawing
- `@ocif/arrow` — arrows with markers

### Structural extensions

- `@ocif/edge` — directed/undirected edges between nodes
- `@ocif/group` — grouping nodes together
- `@ocif/hyperedge` — many-to-many relationships
- Node `parent` property — frame containment / nesting

### Style extensions

- `@ocif/textstyle` — font size, family, color, alignment

### Layout

- `@ocif/ports` — precise anchor points for arrow bindings
- Node `scale` property — scale factor (v0.7.0 core property)

### Resources

- Image, video, and bookmark assets with representations

### tldraw-specific extensions

- `@tldraw/node/note` — sticky notes
- `@tldraw/node/embed` — embedded content (YouTube, etc.)
- `@tldraw/node/bookmark` — bookmarks with metadata
- `@tldraw/node/highlight` — highlighter strokes

## Development

```bash
npm install
npm run build    # Build with tsup
npm test         # Run tests with vitest
npm run dev      # Watch mode
```

## License

MIT

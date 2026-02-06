// ---------------------------------------------------------------------------
// tldraw-ocif — OCIF (Open Canvas Interchange Format) plugin for tldraw
// See: https://github.com/ocwg/spec
// ---------------------------------------------------------------------------

export {
	// Constants
	OCIF_FILE_EXTENSION,
	OCIF_FILE_MIMETYPE,
	// Serialize (tldraw → OCIF)
	serializeTldrawToOcif,
	serializeTldrawToOcifBlob,
	// Parse (OCIF → tldraw)
	parseOcifFile,
	parseAndLoadOcifFile,
} from './ocif'

// Types
export type {
	OcifFile,
	OcifFileParseError,
	OcifNode,
	OcifRelation,
	OcifRepresentation,
	OcifResource,
	OcifSchema,
} from './ocif'

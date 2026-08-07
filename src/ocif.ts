import { b64Vecs } from '@tldraw/tlschema'
import { getIndices, sortByIndex } from '@tldraw/utils'
import {
	AssetRecordType,
	Editor,
	FileHelpers,
	Result,
	TLRecord,
	TLSchema,
	TLStore,
	createTLStore,
	toRichText,
	transact,
} from 'tldraw'

// ---------------------------------------------------------------------------
// Rich-text helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a tldraw rich text (TipTap / ProseMirror JSON) object.
 *
 * We keep our own lightweight implementation so that we don't depend on
 * internal tldraw utilities that may not be exported from the public API.
 */
function renderPlaintextFromRichText(richText: any): string {
	if (!richText) return ''

	function extractText(node: any): string {
		if (!node) return ''
		if (node.text) return node.text

		if (node.content && Array.isArray(node.content)) {
			return node.content
				.map((child: any, i: number) => {
					const text = extractText(child)
					// Add newlines between paragraph-level blocks
					if (child.type === 'paragraph' && i > 0) return '\n' + text
					return text
				})
				.join('')
		}

		return ''
	}

	return extractText(richText)
}

/** Whether any text node in the rich text carries the given mark (e.g. 'bold', 'italic'). */
function richTextHasMark(richText: any, markType: string): boolean {
	if (!richText) return false

	function walk(node: any): boolean {
		if (!node) return false
		if (Array.isArray(node.marks) && node.marks.some((m: any) => m?.type === markType)) {
			return true
		}
		if (Array.isArray(node.content)) return node.content.some(walk)
		return false
	}

	return walk(richText)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @public */
export const OCIF_FILE_MIMETYPE = 'application/vnd.ocif+json' as const

/** @public */
export const OCIF_FILE_EXTENSION = '.ocif.json' as const

// ---------------------------------------------------------------------------
// OCIF types
// ---------------------------------------------------------------------------

/** @public */
export interface OcifRepresentation {
	location?: string
	mimeType?: string
	content?: string
}

/** @public */
export interface OcifNode {
	id: string
	position?: [number, number]
	size?: [number, number]
	resource?: string
	resourceFit?: string
	rotation?: number
	rotationAxis?: [number, number, number]
	scale?: number | number[]
	parent?: string
	deleteWithParent?: boolean
	comment?: string
	data?: Array<{
		type: string
		[key: string]: any
	}>
}

/** @public */
export interface OcifResource {
	id: string
	representations?: OcifRepresentation[]
	data?: string
	mimeType?: string
}

/** @public */
export interface OcifSchema {
	name: string
	uri: string
	location?: string
	schema?: any
}

/** @public */
export interface OcifFile {
	ocif: string
	rootNode?: string
	data?: Array<{ type: string; [key: string]: any }>
	nodes?: OcifNode[]
	resources?: OcifResource[]
	schemas?: OcifSchema[]
}

/** @public */
export type OcifFileParseError =
	| { type: 'notAnOcifFile'; cause: unknown }
	| { type: 'ocifVersionNotSupported'; version: string }
	| { type: 'invalidOcifStructure'; cause: unknown }

// ---------------------------------------------------------------------------
// Serialize (tldraw → OCIF)
// ---------------------------------------------------------------------------

/** @public */
export async function serializeTldrawToOcif(editor: Editor): Promise<string> {
	return serializeTldrawRecordsToOcif(editor.store.allRecords(), {
		pageId: editor.getCurrentPageId(),
		resolveAssetSrc: async (asset) => {
			let src = asset.props.src
			if (!src || src.startsWith('data:')) return src
			try {
				if (!src.startsWith('http')) {
					src = (await editor.resolveAssetUrl(asset.id, { shouldResolveToOriginal: true })) || ''
				}
				// Convert to base64 data URL for portability (same as TLDR export)
				return await FileHelpers.blobToDataUrl(await (await fetch(src)).blob())
			} catch {
				// If conversion fails, keep the original src
				return asset.props.src
			}
		},
	})
}

/**
 * Serialize a set of tldraw records to an OCIF JSON string without needing an
 * `Editor` instance. Only shapes on `opts.pageId` (or the document's first
 * page) are exported, in z-order.
 *
 * @public
 */
export async function serializeTldrawRecordsToOcif(
	records: TLRecord[],
	opts: {
		pageId?: string
		resolveAssetSrc?: (asset: any) => Promise<string | undefined>
	} = {}
): Promise<string> {
	const nodes: OcifNode[] = []
	const resources: OcifResource[] = []
	const usedSchemaTypes = new Set<string>()

	const shapesById = new Map<string, any>()
	const assetsById = new Map<string, any>()
	for (const record of records) {
		if (record.typeName === 'shape') shapesById.set(record.id, record)
		if (record.typeName === 'asset') assetsById.set(record.id, record)
	}

	// Determine the page to export: explicit, else the document's first page.
	const firstPage = (records.filter((r) => r.typeName === 'page') as any[]).sort(sortByIndex)[0]
	const pageId: string = opts.pageId ?? firstPage?.id ?? 'page:page'

	// Group shapes by parent so we can walk the current page's subtree in
	// z-order (siblings sorted by fractional index, parents before children).
	const childrenByParent = new Map<string, any[]>()
	for (const shape of shapesById.values()) {
		const parentId = shape.parentId ?? pageId
		if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, [])
		childrenByParent.get(parentId)!.push(shape)
	}

	const orderedShapes: Array<{ shape: any; pageX: number; pageY: number }> = []
	const visit = (parentId: string, originX: number, originY: number) => {
		const children = childrenByParent.get(parentId)
		if (!children) return
		for (const shape of children.slice().sort(sortByIndex)) {
			const pageX = originX + shape.x
			const pageY = originY + shape.y
			orderedShapes.push({ shape, pageX, pageY })
			visit(shape.id, pageX, pageY)
		}
	}
	visit(pageId, 0, 0)

	// Collect arrow bindings per arrow shape, keeping which terminal each
	// binding attaches to so the edge direction survives the round trip.
	const arrowTerminals = new Map<string, { start?: string; end?: string }>()
	for (const record of records) {
		if (record.typeName === 'binding' && (record as any).type === 'arrow') {
			const binding = record as any
			const entry = arrowTerminals.get(binding.fromId) ?? {}
			if (binding.props?.terminal === 'start') {
				entry.start = binding.toId
			} else {
				entry.end = binding.toId
			}
			arrowTerminals.set(binding.fromId, entry)
		}
	}

	for (const { shape, pageX, pageY } of orderedShapes) {
		const parentShape = shape.parentId ? shapesById.get(shape.parentId) : undefined

		// Groups become nodes with @ocif/group extension
		if (shape.type === 'group') {
			const members = (childrenByParent.get(shape.id) ?? []).map((s) => s.id)
			if (members.length > 0) {
				nodes.push({
					id: shape.id,
					position: [pageX, pageY],
					data: [
						{
							type: '@ocif/group',
							members,
							cascadeDelete: true,
						},
					],
				})
				usedSchemaTypes.add('@ocif/group')
			}
			continue
		}

		// Children of frames keep frame-relative positions (OCIF `parent`
		// containment semantics); everything else is exported in page space.
		const useRelativePosition = parentShape?.type === 'frame'
		const node = convertTldrawShapeToOcifNode(
			shape,
			useRelativePosition ? [shape.x, shape.y] : [pageX, pageY],
			assetsById
		)
		if (!node) continue
		node.data = node.data ?? []

		// One edge extension per arrow, with start/end pointing at the nodes
		// bound at the arrow's start/end terminals.
		const terminals = arrowTerminals.get(shape.id)
		if (terminals && (terminals.start || terminals.end)) {
			const edge: any = { type: '@ocif/edge' }
			if (terminals.start) edge.start = terminals.start
			if (terminals.end) edge.end = terminals.end
			node.data.push(edge)
			usedSchemaTypes.add('@ocif/edge')
		}

		if (useRelativePosition) {
			node.parent = shape.parentId
		}

		nodes.push(node)
		node.data.forEach((d) => usedSchemaTypes.add(d.type))
	}

	// Collect referenced resources
	const referencedResourceIds = new Set<string>()
	for (const node of nodes) {
		if (node.resource) referencedResourceIds.add(node.resource)
		for (const d of node.data ?? []) {
			if (d.assetId) referencedResourceIds.add(d.assetId)
		}
	}

	for (const record of records) {
		if (record.typeName === 'asset' && referencedResourceIds.has(record.id)) {
			const resource = await convertTldrawAssetToOcifResource(record as any, opts.resolveAssetSrc)
			if (resource) resources.push(resource)
		}
	}

	const schemas = getOcifSchemas().filter(
		(schema) => usedSchemaTypes.has(schema.name) || schema.name === 'ocif'
	)

	const ocifFile: OcifFile = {
		ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
		nodes,
		resources: resources.length > 0 ? resources : undefined,
		schemas: schemas.length > 0 ? schemas : undefined,
	}

	return JSON.stringify(ocifFile, null, 2)
}

/** @public */
export async function serializeTldrawToOcifBlob(editor: Editor): Promise<Blob> {
	return new Blob([await serializeTldrawToOcif(editor)], { type: OCIF_FILE_MIMETYPE })
}

// ---------------------------------------------------------------------------
// Parse (OCIF → tldraw)
// ---------------------------------------------------------------------------

/** @public */
export function parseOcifFile({
	json,
	schema,
}: {
	schema: TLSchema
	json: string
}): Result<TLStore, OcifFileParseError> {
	let data: OcifFile
	try {
		data = JSON.parse(json)
		if (!data.ocif) {
			throw new Error('Invalid OCIF structure')
		}
	} catch (e) {
		return Result.err({ type: 'notAnOcifFile', cause: e })
	}

	// Accept v0.7 and v0.7.x only (a negative lookahead keeps v0.71 etc. out).
	if (!/v0\.7(?!\d)/.test(data.ocif)) {
		return Result.err({ type: 'ocifVersionNotSupported', version: data.ocif })
	}

	try {
		const records: TLRecord[] = []
		const assetMap = new Map<string, string>()
		const altTextMap = new Map<string, string>()
		const groupRelations = new Map<string, string[]>()
		const parentChildRelations = new Map<string, string>()
		const hyperedgeNodes: OcifNode[] = []
		const edgesByNode = new Map<string, Array<{ start?: string; end?: string }>>()

		// Convert OCIF resources to TLDraw assets
		const resourceTypeMap = new Map<string, string>()
		if (data.resources) {
			for (const resource of data.resources) {
				const assetResult = convertOcifResourceToTldrawAsset(resource)
				if (assetResult) {
					records.push(assetResult.asset)
					assetMap.set(resource.id, assetResult.asset.id)
					resourceTypeMap.set(resource.id, (assetResult.asset as any).type)
					if (assetResult.altText) {
						altTextMap.set(resource.id, assetResult.altText)
					}
				}
			}
		}

		// Extract structural info from node extensions
		for (const node of data.nodes ?? []) {
			if (node.parent) {
				parentChildRelations.set(node.id, node.parent)
			}

			for (const d of node.data ?? []) {
				if (d.type === '@ocif/group') {
					groupRelations.set(node.id, d.members || [])
				} else if (d.type === '@ocif/edge') {
					if (!edgesByNode.has(node.id)) edgesByNode.set(node.id, [])
					edgesByNode.get(node.id)!.push({ start: d.start, end: d.end })
				} else if (d.type === '@ocif/hyperedge') {
					hyperedgeNodes.push(node)
				}
			}
		}

		// Convert OCIF nodes to TLDraw shapes
		const structuralOnlyTypes = new Set([
			'@ocif/group',
			'@ocif/hyperedge',
			'@ocif/edge',
			'@ocif/inherit',
		])
		for (const node of data.nodes ?? []) {
			// Skip nodes that are purely structural (no visual representation).
			// Pure edge/hyperedge nodes get synthesized arrows further below.
			const nodeData = node.data ?? []
			const isStructuralOnly =
				nodeData.length > 0 && nodeData.every((d) => structuralOnlyTypes.has(d.type))
			if (isStructuralOnly) continue

			const shapeRecord = convertOcifNodeToTldrawShape(node, assetMap, altTextMap, resourceTypeMap)
			if (shapeRecord) {
				records.push(shapeRecord)
			}
		}

		const shapeRecordsById = new Map<string, any>()
		for (const r of records) {
			if (r.typeName === 'shape') shapeRecordsById.set(r.id, r)
		}
		const toShapeId = (id: string) => (id.startsWith('shape:') ? id : `shape:${id}`)

		// Apply frame containment (`parent` property), only for parents that exist
		for (const [childId, parentId] of parentChildRelations) {
			const child = shapeRecordsById.get(toShapeId(childId))
			const parent = shapeRecordsById.get(toShapeId(parentId))
			if (child && parent) {
				child.parentId = parent.id
			}
		}

		// Create group shapes and set up parent-child relationships
		for (const [groupId, memberIds] of groupRelations) {
			const groupShapeId = toShapeId(groupId)

			let minX = Infinity,
				minY = Infinity
			const memberShapes = memberIds
				.map((id) => shapeRecordsById.get(toShapeId(id)))
				.filter(Boolean)

			for (const shape of memberShapes) {
				minX = Math.min(minX, shape.x)
				minY = Math.min(minY, shape.y)
			}

			if (memberShapes.length > 0) {
				// Check if group node already has position from OCIF
				const groupNode = (data.nodes ?? []).find((n) => n.id === groupId)
				const groupX = groupNode?.position?.[0] ?? minX
				const groupY = groupNode?.position?.[1] ?? minY

				const groupShape = {
					id: groupShapeId,
					typeName: 'shape' as const,
					type: 'group',
					x: groupX,
					y: groupY,
					rotation: 0,
					index: 'a1' as any,
					parentId: 'page:page' as any,
					isLocked: false,
					opacity: 1,
					meta: {},
					props: {},
				} as any
				records.push(groupShape)
				shapeRecordsById.set(groupShapeId, groupShape)

				// OCIF member positions are absolute; tldraw children are
				// relative to their group parent.
				for (const shape of memberShapes) {
					shape.parentId = groupShapeId
					shape.x -= groupX
					shape.y -= groupY
				}
			}
		}

		// --- Edge and hyperedge reconstruction -----------------------------

		const centerOf = (id: string): { x: number; y: number } | null => {
			const rec = shapeRecordsById.get(toShapeId(id))
			if (!rec) return null
			return {
				x: rec.x + (rec.props?.w ?? 100) / 2,
				y: rec.y + (rec.props?.h ?? 100) / 2,
			}
		}

		const pushArrowBinding = (id: string, fromId: string, toId: string, terminal: 'start' | 'end') => {
			records.push({
				id,
				typeName: 'binding',
				type: 'arrow',
				fromId,
				toId,
				meta: {},
				props: {
					terminal,
					normalizedAnchor: { x: 0.5, y: 0.5 },
					isExact: false,
					isPrecise: false,
					snap: 'none',
				},
			} as any)
		}

		// Synthesize a visible arrow shape connecting two nodes, bound at both
		// terminals. Used for pure structural edges and hyperedges, which have
		// no visual representation of their own in the OCIF file.
		const synthesizeArrow = (idBase: string, startId: string, endId: string): boolean => {
			const startCenter = centerOf(startId)
			const endCenter = centerOf(endId)
			if (!startCenter || !endCenter) return false

			const arrowShapeId = toShapeId(idBase)
			if (shapeRecordsById.has(arrowShapeId)) return false

			const arrowShape = {
				id: arrowShapeId,
				typeName: 'shape' as const,
				type: 'arrow',
				x: startCenter.x,
				y: startCenter.y,
				rotation: 0,
				index: 'a1' as any,
				parentId: 'page:page' as any,
				isLocked: false,
				opacity: 1,
				meta: {},
				props: {
					kind: 'arc',
					color: 'black',
					labelColor: 'black',
					fill: 'none',
					dash: 'draw',
					size: 'm',
					arrowheadStart: 'none',
					arrowheadEnd: 'arrow',
					font: 'draw',
					start: { x: 0, y: 0 },
					end: { x: endCenter.x - startCenter.x, y: endCenter.y - startCenter.y },
					bend: 0,
					richText: toRichText(''),
					labelPosition: 0.5,
					scale: 1,
					elbowMidPoint: 0,
				},
			} as any
			records.push(arrowShape)
			shapeRecordsById.set(arrowShapeId, arrowShape)

			pushArrowBinding(`binding:${idBase}-start`, arrowShapeId, toShapeId(startId), 'start')
			pushArrowBinding(`binding:${idBase}-end`, arrowShapeId, toShapeId(endId), 'end')
			return true
		}

		// Convert edge extensions to tldraw bindings
		for (const [nodeId, edges] of edgesByNode) {
			const ownShapeId = toShapeId(nodeId)
			const ownShape = shapeRecordsById.get(ownShapeId)
			const isArrowShape = ownShape?.type === 'arrow'

			// Legacy tldraw exports wrote one edge per binding with
			// `start` pointing at the arrow node itself.
			const isLegacy = edges.length > 0 && edges.every((e) => e.start === nodeId)

			if (isArrowShape && isLegacy) {
				edges.forEach((edge, i) => {
					if (!edge.end) return
					const target = shapeRecordsById.get(toShapeId(edge.end))
					if (!target) return
					// With two legacy edges the terminals are unrecoverable —
					// assign start/end in order as a best effort.
					const terminal = edges.length >= 2 && i === 0 ? 'start' : 'end'
					pushArrowBinding(`binding:edge-${nodeId}-${i}`, ownShapeId, target.id, terminal)
				})
				continue
			}

			if (isArrowShape) {
				// Spec-compliant edge on a visual arrow node: bind the arrow's
				// terminals to the referenced nodes. Extra edges (rare) become
				// synthesized arrows.
				edges.forEach((edge, i) => {
					if (i === 0) {
						if (edge.start && shapeRecordsById.has(toShapeId(edge.start))) {
							pushArrowBinding(
								`binding:edge-${nodeId}-start`,
								ownShapeId,
								toShapeId(edge.start),
								'start'
							)
						}
						if (edge.end && shapeRecordsById.has(toShapeId(edge.end))) {
							pushArrowBinding(`binding:edge-${nodeId}-end`, ownShapeId, toShapeId(edge.end), 'end')
						}
					} else if (edge.start && edge.end) {
						synthesizeArrow(`edge-${nodeId}-${i}`, edge.start, edge.end)
					}
				})
				continue
			}

			// Pure structural edge node (or a non-arrow visual node carrying an
			// edge): synthesize an arrow so the connection is visible and bound.
			edges.forEach((edge, i) => {
				if (!edge.start || !edge.end) return
				const idBase = !ownShape && edges.length === 1 ? nodeId : `edge-${nodeId}-${i}`
				synthesizeArrow(idBase, edge.start, edge.end)
			})
		}

		// Process hyperedge nodes: synthesize an arrow per connection
		for (const hyperedge of hyperedgeNodes) {
			const heData = (hyperedge.data ?? []).find((d) => d.type === '@ocif/hyperedge')
			if (heData?.endpoints) {
				const endpoints = heData.endpoints
				const inEndpoints = endpoints.filter((ep: any) => ep.direction === 'in')
				const outEndpoints = endpoints.filter((ep: any) => ep.direction === 'out')
				const undirEndpoints = endpoints.filter((ep: any) => ep.direction === 'undir')

				if (inEndpoints.length > 0 && outEndpoints.length > 0) {
					for (let i = 0; i < Math.max(inEndpoints.length, outEndpoints.length); i++) {
						const inEp = inEndpoints[i % inEndpoints.length]
						const outEp = outEndpoints[i % outEndpoints.length]
						synthesizeArrow(`hyperedge-${hyperedge.id}-${i}`, inEp.id, outEp.id)
					}
				}

				for (let i = 0; i < undirEndpoints.length - 1; i++) {
					synthesizeArrow(
						`hyperedge-undir-${hyperedge.id}-${i}`,
						undirEndpoints[i].id,
						undirEndpoints[i + 1].id
					)
				}
			}
		}

		// Assign unique ascending fractional indexes per parent so z-order
		// follows the OCIF node order instead of colliding on 'a1'.
		const shapesByParent = new Map<string, any[]>()
		for (const r of records) {
			if (r.typeName !== 'shape') continue
			const parentId = (r as any).parentId ?? 'page:page'
			if (!shapesByParent.has(parentId)) shapesByParent.set(parentId, [])
			shapesByParent.get(parentId)!.push(r)
		}
		for (const siblings of shapesByParent.values()) {
			const indices = getIndices(siblings.length)
			siblings.forEach((s, i) => {
				s.index = indices[i]
			})
		}

		// Filter out any records that might be invalid or have broken references
		const shapeIdSet = new Set(
			records.filter((r) => r.typeName === 'shape').map((r) => r.id as string)
		)
		const validRecords = records.filter((record) => {
			// Basic validation - ensure required properties exist
			if (!record.id || !record.typeName) {
				return false
			}

			// For shapes, ensure they have valid properties
			if (record.typeName === 'shape') {
				const shape = record as any
				return shape.type && typeof shape.x === 'number' && typeof shape.y === 'number'
			}

			// For bindings, ensure they reference valid shapes
			if (record.typeName === 'binding') {
				const binding = record as any
				return shapeIdSet.has(binding.fromId) && shapeIdSet.has(binding.toId)
			}

			// For assets, ensure they have valid properties
			if (record.typeName === 'asset') {
				const asset = record as any
				return asset.type && asset.props
			}

			return true
		})

		// Prune unused assets (same logic as TLDR files)
		const usedAssets = new Set<string>()
		for (const record of validRecords) {
			if (
				record.typeName === 'shape' &&
				'assetId' in (record as any).props &&
				(record as any).props.assetId
			) {
				usedAssets.add((record as any).props.assetId)
			}
		}
		const prunedRecords = validRecords.filter((r) => r.typeName !== 'asset' || usedAssets.has(r.id))

		// Create a store with the validated records
		const storeSnapshot = Object.fromEntries(prunedRecords.map((r) => [r.id, r]))
		return Result.ok(
			createTLStore({
				snapshot: { store: storeSnapshot, schema: schema.serialize() },
				schema,
			})
		)
	} catch (e) {
		return Result.err({ type: 'invalidOcifStructure', cause: e })
	}
}

// ---------------------------------------------------------------------------
// Parse + load helper
// ---------------------------------------------------------------------------

const DEFAULT_ERROR_STRINGS = {
	title: 'Could not open file',
	notAnOcifFile: 'This is not a valid OCIF file.',
	versionNotSupported: 'This OCIF file uses an unsupported format version.',
	corrupted: 'This OCIF file could not be read. It may be corrupted.',
}

/** @public */
export async function parseAndLoadOcifFile(
	editor: Editor,
	document: string,
	msg?: (id: string) => string,
	addToast?: (toast: { title: string; description?: string; severity?: string }) => void,
	forceDarkMode?: boolean
) {
	const parseFileResult = parseOcifFile({
		schema: editor.store.schema,
		json: document,
	})
	if (!parseFileResult.ok) {
		let description
		switch (parseFileResult.error.type) {
			case 'notAnOcifFile':
				console.error('[tldraw-ocif] Not a valid OCIF file', parseFileResult.error.cause)
				description = msg
					? msg('file-system.file-open-error.not-a-tldraw-file')
					: DEFAULT_ERROR_STRINGS.notAnOcifFile
				break
			case 'ocifVersionNotSupported':
				description = msg
					? msg('file-system.file-open-error.file-format-version-too-new')
					: DEFAULT_ERROR_STRINGS.versionNotSupported
				break
			case 'invalidOcifStructure':
				console.error('[tldraw-ocif] Invalid OCIF structure', parseFileResult.error.cause)
				description = msg
					? msg('file-system.file-open-error.generic-corrupted-file')
					: DEFAULT_ERROR_STRINGS.corrupted
				break
			default:
				description = msg
					? msg('file-system.file-open-error.generic-corrupted-file')
					: DEFAULT_ERROR_STRINGS.corrupted
				break
		}
		addToast?.({
			title: msg ? msg('file-system.file-open-error.title') : DEFAULT_ERROR_STRINGS.title,
			description,
			severity: 'error',
		})

		return
	}

	// Import the OCIF data into the editor
	transact(() => {
		const snapshot = parseFileResult.value.getStoreSnapshot()
		editor.loadSnapshot(snapshot)
		editor.clearHistory()

		const bounds = editor.getCurrentPageBounds()
		if (bounds) {
			editor.zoomToBounds(bounds, { targetZoom: 1, immediate: true })
		}
	})

	if (forceDarkMode) editor.user.updateUserPreferences({ colorScheme: 'dark' })
}

// ---------------------------------------------------------------------------
// Internal helpers – tldraw shape → OCIF node
// ---------------------------------------------------------------------------

/**
 * Decode a tldraw 5.x draw segment into absolute points. Falls back to the
 * legacy `points` array shape for pre-compression data.
 */
function segmentToPoints(segment: any): Array<{ x: number; y: number; z?: number }> {
	if (!segment) return []
	if (Array.isArray(segment.points)) return segment.points
	if (typeof segment.path === 'string' && segment.path.length > 0) {
		try {
			return b64Vecs.decodePoints(segment.path)
		} catch {
			return []
		}
	}
	return []
}

function calculateDrawShapeSize(segments: any[]): [number, number] {
	if (!segments || segments.length === 0) {
		return [100, 100]
	}

	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity

	for (const segment of segments) {
		for (const point of segmentToPoints(segment)) {
			minX = Math.min(minX, point.x)
			minY = Math.min(minY, point.y)
			maxX = Math.max(maxX, point.x)
			maxY = Math.max(maxY, point.y)
		}
	}

	if (minX === Infinity || minY === Infinity || maxX === -Infinity || maxY === -Infinity) {
		return [100, 100]
	}

	return [Math.max(maxX - minX, 10), Math.max(maxY - minY, 10)]
}

function convertTldrawShapeToOcifNode(
	shape: any,
	position: [number, number],
	assetsById: Map<string, any>
): OcifNode | null {
	let size: [number, number]
	if (shape.type === 'draw' || shape.type === 'highlight') {
		size = calculateDrawShapeSize(shape.props.segments)
	} else {
		size = [shape.props.w || 100, shape.props.h || 100]
	}

	const data: Array<{ type: string; [key: string]: any }> = []
	let scale: number | undefined

	if (shape.props.scale && shape.props.scale !== 1) {
		scale = shape.props.scale
	}

	switch (shape.type) {
		case 'geo': {
			let nodeType = '@ocif/rect'
			if (shape.props.geo === 'ellipse' || shape.props.geo === 'oval') {
				nodeType = '@ocif/oval'
			}

			const nodeData: any = {
				type: nodeType,
				strokeColor: convertTldrawColorToHex(shape.props.color),
				fillColor: convertTldrawFillToHex(shape.props.fill, shape.props.color),
				strokeWidth: convertTldrawSizeToPixels(shape.props.size),
			}

			if (
				shape.props.geo !== 'rectangle' &&
				shape.props.geo !== 'ellipse' &&
				shape.props.geo !== 'oval'
			) {
				nodeData.geoType = shape.props.geo
			}

			if (shape.props.flipX) nodeData.flipX = true
			if (shape.props.flipY) nodeData.flipY = true

			const geoText = renderPlaintextFromRichText(shape.props.richText)
			if (geoText && geoText.trim()) {
				nodeData.text = geoText
				nodeData.textColor = convertTldrawColorToHex(shape.props.labelColor || shape.props.color)
				nodeData.fontSize = convertTldrawSizeToPixels(shape.props.size) * 4
				nodeData.fontFamily = convertTldrawFontToCSS(shape.props.font || 'draw')
				nodeData.textAlign = shape.props.align || 'middle'
			}

			data.push(nodeData)
			break
		}
		case 'text': {
			const textNodeData: any = {
				type: '@ocif/rect',
				strokeColor: 'transparent',
				fillColor: 'transparent',
				strokeWidth: 0,
				text: renderPlaintextFromRichText(shape.props.richText),
				textColor: convertTldrawColorToHex(shape.props.color),
				fontSize: convertTldrawSizeToPixels(shape.props.size) * 4,
				fontFamily: convertTldrawFontToCSS(shape.props.font || 'draw'),
				textAlign: convertTldrawTextAlignToOcif(shape.props.textAlign || 'start'),
			}

			data.push(textNodeData)

			data.push({
				type: '@ocif/textstyle',
				fontSizePx: convertTldrawSizeToPixels(shape.props.size) * 4,
				fontFamily: convertTldrawFontToCSS(shape.props.font || 'draw'),
				color: convertTldrawColorToHex(shape.props.color),
				align: convertTldrawTextAlignToOcifStyle(shape.props.textAlign || 'start'),
				bold: richTextHasMark(shape.props.richText, 'bold'),
				italic: richTextHasMark(shape.props.richText, 'italic'),
			})

			break
		}
		case 'draw': {
			const pathData = convertDrawSegmentsToSvgPath(shape.props.segments)
			data.push({
				type: '@ocif/path',
				strokeColor: convertTldrawColorToHex(shape.props.color),
				fillColor: shape.props.isClosed
					? convertTldrawFillToHex(shape.props.fill, shape.props.color)
					: 'transparent',
				strokeWidth: convertTldrawSizeToPixels(shape.props.size),
				path: pathData,
				closed: shape.props.isClosed || false,
			})
			break
		}
		case 'arrow': {
			const arrowData: any = {
				type: '@ocif/arrow',
				strokeColor: convertTldrawColorToHex(shape.props.color),
				start: [shape.props.start.x, shape.props.start.y],
				end: [shape.props.end.x, shape.props.end.y],
				startMarker: convertTldrawArrowheadToOcif(shape.props.arrowheadStart),
				endMarker: convertTldrawArrowheadToOcif(shape.props.arrowheadEnd),
				strokeWidth: convertTldrawSizeToPixels(shape.props.size),
			}

			const arrowText = renderPlaintextFromRichText(shape.props.richText)
			if (arrowText) {
				arrowData.text = arrowText
				arrowData.labelColor = convertTldrawColorToHex(shape.props.labelColor || 'black')
				arrowData.labelPosition = shape.props.labelPosition ?? 0.5
			}

			data.push(arrowData)
			break
		}
		case 'frame': {
			data.push({
				type: '@ocif/rect',
				strokeColor: convertTldrawColorToHex(shape.props.color || 'black'),
				fillColor: 'transparent',
				strokeWidth: 2,
				isFrame: true,
				frameName: shape.props.name || '',
			})
			break
		}
		case 'image':
		case 'video': {
			const node: OcifNode = {
				id: shape.id,
				position,
				size,
				rotation: shape.rotation || 0,
				data: [],
			}
			if (shape.props.assetId) {
				node.resource = shape.props.assetId
				node.resourceFit = 'contain'
			}
			if (scale) node.scale = scale
			return node
		}
		case 'note': {
			data.push({
				type: '@tldraw/node/note',
				text: renderPlaintextFromRichText(shape.props.richText),
				color: convertTldrawColorToHex(shape.props.color),
				labelColor: convertTldrawColorToHex(shape.props.labelColor || shape.props.color),
				fontSizePx:
					shape.props.fontSizeAdjustment || convertTldrawSizeToPixels(shape.props.size) * 4,
				fontFamily: convertTldrawFontToCSS(shape.props.font || 'draw'),
				align: shape.props.align || 'middle',
				verticalAlign: shape.props.verticalAlign || 'middle',
				growY: shape.props.growY || 0,
				url: shape.props.url || '',
			})
			break
		}
		case 'embed': {
			data.push({
				type: '@tldraw/node/embed',
				url: shape.props.url || '',
				w: shape.props.w || 100,
				h: shape.props.h || 100,
			})
			break
		}
		case 'bookmark': {
			let title = ''
			let description = ''
			let favicon = ''
			let image = ''

			if (shape.props.assetId) {
				const asset = assetsById.get(shape.props.assetId)
				if (asset && asset.type === 'bookmark') {
					title = asset.props.title || ''
					description = asset.props.description || ''
					favicon = asset.props.favicon || ''
					image = asset.props.image || ''
				}
			}

			data.push({
				type: '@tldraw/node/bookmark',
				assetId: shape.props.assetId,
				url: shape.props.url || '',
				title,
				description,
				favicon,
				image,
			})
			break
		}
		case 'highlight': {
			const pathData = convertDrawSegmentsToSvgPath(shape.props.segments)
			data.push({
				type: '@tldraw/node/highlight',
				path: pathData,
				color: convertTldrawColorToHex(shape.props.color),
				size: convertTldrawSizeToPixels(shape.props.size),
				isComplete: shape.props.isComplete,
			})
			break
		}
		case 'line': {
			const points = Object.values(shape.props.points || {}).sort((a: any, b: any) =>
				a.index.localeCompare(b.index)
			)
			let path = ''
			if (points.length >= 2) {
				const firstPoint = points[0] as any
				path = `M${firstPoint.x},${firstPoint.y}`
				for (let i = 1; i < points.length; i++) {
					const point = points[i] as any
					path += ` L${point.x},${point.y}`
				}
			}

			data.push({
				type: '@ocif/path',
				strokeColor: convertTldrawColorToHex(shape.props.color),
				fillColor: 'transparent',
				strokeWidth: convertTldrawSizeToPixels(shape.props.size),
				path,
				closed: false,
				spline: shape.props.spline || 'line',
			})
			break
		}
		case 'group':
			return null
		default:
			data.push({
				type: '@ocif/rect',
				strokeColor: convertTldrawColorToHex('black'),
				fillColor: 'transparent',
				strokeWidth: 1,
			})
			break
	}

	const node: OcifNode = {
		id: shape.id,
		position,
		size,
		rotation: shape.rotation || 0,
		data,
	}
	if (scale) node.scale = scale
	return node
}

// ---------------------------------------------------------------------------
// Internal helpers – tldraw asset → OCIF resource
// ---------------------------------------------------------------------------

async function convertTldrawAssetToOcifResource(
	asset: any,
	resolveAssetSrc?: (asset: any) => Promise<string | undefined>
): Promise<OcifResource | null> {
	if (asset.type === 'image' || asset.type === 'video') {
		const representations: OcifRepresentation[] = []

		// Inline the data as base64 where possible for portability
		let assetSrcToSave = asset.props.src
		if (resolveAssetSrc) {
			assetSrcToSave = (await resolveAssetSrc(asset)) ?? asset.props.src
		}

		if (assetSrcToSave) {
			representations.push({
				content: assetSrcToSave,
				mimeType: asset.props.mimeType,
			})
		}

		return {
			id: asset.id,
			representations,
		}
	} else if (asset.type === 'bookmark') {
		const representations: OcifRepresentation[] = []

		// Add the main bookmark URL
		if (asset.props.src) {
			representations.push({
				location: asset.props.src,
				mimeType: 'text/html',
			})
		}

		// Add metadata as JSON representation
		const metadata = {
			title: asset.props.title || '',
			description: asset.props.description || '',
			image: asset.props.image || '',
			favicon: asset.props.favicon || '',
		}

		representations.push({
			content: JSON.stringify(metadata),
			mimeType: 'application/json',
		})

		return {
			id: asset.id,
			representations,
		}
	}

	return null
}

// ---------------------------------------------------------------------------
// Internal helpers – OCIF resource → tldraw asset
// ---------------------------------------------------------------------------

function convertOcifResourceToTldrawAsset(
	resource: OcifResource
): { asset: TLRecord; altText: string } | null {
	// Strip any existing 'asset:' prefix so tldraw exports round-trip with
	// their original record IDs instead of gaining a double prefix.
	const id = AssetRecordType.createId(
		resource.id.startsWith('asset:') ? resource.id.slice('asset:'.length) : resource.id
	)

	// Extract data and mimeType from either new representations format or legacy format
	let assetData: string | undefined
	let mimeType: string | undefined
	let altText = ''
	let bookmarkMetadata: any = null

	if (resource.representations && resource.representations.length > 0) {
		// Look for the best representation, preferring location over content
		let selectedRep = resource.representations[0]

		// Try to find a location-based representation first
		const locationRep = resource.representations.find((rep) => rep.location)
		if (locationRep) {
			selectedRep = locationRep
		}

		assetData = selectedRep.content || selectedRep.location
		mimeType = selectedRep.mimeType

		// Look for plain text fallback for altText
		const textFallback = resource.representations.find(
			(rep) => rep.mimeType === 'text/plain' && rep.content
		)
		if (textFallback && textFallback.content) {
			altText = textFallback.content
		}

		// Look for bookmark metadata (JSON representation)
		const jsonRep = resource.representations.find(
			(rep) => rep.mimeType === 'application/json' && rep.content
		)
		if (jsonRep && jsonRep.content) {
			try {
				bookmarkMetadata = JSON.parse(jsonRep.content)
			} catch (_e) {
				// Ignore parsing errors
			}
		}
	} else {
		// Fallback to legacy format
		assetData = resource.data
		mimeType = resource.mimeType
	}

	if (!assetData || !mimeType) {
		return null
	}

	if (mimeType.startsWith('image/')) {
		return {
			asset: AssetRecordType.create({
				id,
				type: 'image',
				props: {
					name: `asset-${resource.id}`,
					src: assetData,
					w: 100,
					h: 100,
					mimeType: mimeType,
					isAnimated: false,
					fileSize: undefined,
				},
			}),
			altText,
		}
	} else if (mimeType.startsWith('video/')) {
		return {
			asset: AssetRecordType.create({
				id,
				type: 'video',
				props: {
					name: `asset-${resource.id}`,
					src: assetData,
					w: 100,
					h: 100,
					mimeType: mimeType,
					isAnimated: true,
					fileSize: undefined,
				},
			}),
			altText,
		}
	} else if (mimeType === 'text/html' && bookmarkMetadata) {
		// This is a bookmark asset
		return {
			asset: AssetRecordType.create({
				id,
				type: 'bookmark',
				props: {
					title: bookmarkMetadata.title || '',
					description: bookmarkMetadata.description || '',
					image: bookmarkMetadata.image || '',
					favicon: bookmarkMetadata.favicon || '',
					src: assetData,
				},
			}),
			altText,
		}
	}

	return null
}

// ---------------------------------------------------------------------------
// Internal helpers – OCIF node → tldraw shape
// ---------------------------------------------------------------------------

function convertOcifNodeToTldrawShape(
	node: OcifNode,
	assetMap: Map<string, string>,
	altTextMap: Map<string, string>,
	resourceTypeMap: Map<string, string>
): TLRecord | null {
	const [x, y] = node.position ?? [0, 0]
	const [w, h] = node.size || [100, 100]
	const nodeData = node.data ?? []

	const textStyleExtension = nodeData.find((d) => d.type === '@ocif/textstyle')

	const shapeId = node.id.startsWith('shape:') ? node.id : `shape:${node.id}`

	const baseShape = {
		id: shapeId,
		typeName: 'shape' as const,
		x,
		y,
		rotation: node.rotation || 0,
		index: 'a1',
		parentId: 'page:page',
		isLocked: false,
		opacity: 1,
		meta: {},
	}

	let scale = 1
	if (node.scale != null) {
		scale = Array.isArray(node.scale) ? node.scale[0] : node.scale
	}

	// Handle nodes with empty data arrays (pure resource nodes)
	if (nodeData.length === 0 && node.resource) {
		// This is a pure resource node (image/video)
		const assetId = assetMap.get(node.resource)
		const altText = altTextMap.get(node.resource) || ''
		const resourceType = resourceTypeMap.get(node.resource) || 'image'

		if (assetId) {
			if (resourceType === 'video') {
				return {
					...baseShape,
					type: 'video',
					props: {
						assetId: assetId,
						w,
						h,
						time: 0,
						playing: false,
						autoplay: true,
						url: '',
						altText: altText,
					},
				} as any
			} else {
				return {
					...baseShape,
					type: 'image',
					props: {
						assetId: assetId,
						w,
						h,
						playing: true,
						url: '',
						crop: null,
						flipX: false,
						flipY: false,
						altText: altText,
					},
				} as any
			}
		}
		return null
	}

	// Find the primary data type
	const primaryData = nodeData[0]
	if (!primaryData) return null

	switch (primaryData.type) {
		case '@ocif/rect':
			if (primaryData.isFrame) {
				// Frame node — becomes a tldraw frame shape directly, so empty
				// frames survive the round trip too.
				return {
					...baseShape,
					type: 'frame',
					props: {
						w,
						h,
						name: primaryData.frameName || '',
						color: convertHexToTldrawColor(primaryData.strokeColor || '#000000'),
					},
				} as any
			} else if (
				primaryData.text &&
				primaryData.strokeColor === 'transparent' &&
				primaryData.strokeWidth === 0
			) {
				// This is a pure text node (transparent stroke, zero width)
				const fontSize = textStyleExtension?.fontSizePx || primaryData.fontSize || 12
				const fontFamily = textStyleExtension?.fontFamily || primaryData.fontFamily || 'draw'
				const textAlign = textStyleExtension?.align || primaryData.textAlign || 'left'
				const color = textStyleExtension?.color || primaryData.textColor || primaryData.strokeColor

				const textProps: any = {
					color: convertHexToTldrawColor(color),
					size: convertPixelsToTldrawSize(fontSize / 4),
					font: convertCSSFontToTldraw(fontFamily),
					textAlign: convertOcifTextAlignToTldraw(textAlign),
					w: Math.max(w, 8),
					autoSize: true,
					richText: toRichText(primaryData.text || ''),
					scale: scale,
				}

				return {
					...baseShape,
					type: 'text',
					props: textProps,
				} as any
			} else if (node.resource) {
				// This is an image node
				const assetId = assetMap.get(node.resource)
				const altText = altTextMap.get(node.resource) || ''
				if (assetId) {
					return {
						...baseShape,
						type: 'image',
						props: {
							assetId: assetId,
							w,
							h,
							playing: true,
							url: '',
							crop: null,
							flipX: false,
							flipY: false,
							altText: altText,
						},
					} as any
				}
			} else {
				// Regular rectangle (or other geo shapes like diamond, star, etc.)
				const props: any = {
					geo: primaryData.geoType || 'rectangle',
					color: convertHexToTldrawColor(primaryData.strokeColor),
					fill: convertHexToTldrawFill(primaryData.fillColor),
					size: convertPixelsToTldrawSize(primaryData.strokeWidth),
					w,
					h,
					growY: 0,
					font: 'draw',
					align: primaryData.textAlign || 'middle',
					verticalAlign: 'middle',
					url: '',
					dash: 'draw',
					labelColor: primaryData.textColor
						? convertHexToTldrawColor(primaryData.textColor)
						: 'black',
					richText: primaryData.text ? toRichText(primaryData.text) : toRichText(''),
					flipX: primaryData.flipX === true,
					flipY: primaryData.flipY === true,
				}

				// Always add scale property (tldraw schema requires it)
				props.scale = scale

				return {
					...baseShape,
					type: 'geo',
					props,
				} as any
			}

			return null

		case '@ocif/oval': {
			const props: any = {
				geo: 'ellipse',
				color: convertHexToTldrawColor(primaryData.strokeColor),
				fill: convertHexToTldrawFill(primaryData.fillColor),
				size: convertPixelsToTldrawSize(primaryData.strokeWidth),
				w,
				h,
				growY: 0,
				font: 'draw',
				align: 'middle',
				verticalAlign: 'middle',
				url: '',
				dash: 'draw',
				labelColor: 'black',
				richText: toRichText(''),
				flipX: primaryData.flipX === true,
				flipY: primaryData.flipY === true,
			}

			// Always add scale property (tldraw schema requires it)
			props.scale = scale

			return {
				...baseShape,
				type: 'geo',
				props,
			} as any
		}

		case '@ocif/path': {
			const segments = convertSvgPathToDrawSegments(primaryData.path || '')
			const props: any = {
				segments,
				color: convertHexToTldrawColor(primaryData.strokeColor),
				fill: convertHexToTldrawFill(primaryData.fillColor),
				dash: 'draw',
				size: convertPixelsToTldrawSize(primaryData.strokeWidth),
				isComplete: true,
				isClosed: primaryData.closed || false,
				isPen: false,
				scale: scale,
				scaleX: 1,
				scaleY: 1,
			}

			return {
				...baseShape,
				type: 'draw',
				props,
			} as any
		}

		case '@ocif/arrow':
			return {
				...baseShape,
				type: 'arrow',
				props: {
					kind: 'arc',
					color: convertHexToTldrawColor(primaryData.strokeColor),
					size: convertPixelsToTldrawSize(primaryData.strokeWidth),
					arrowheadStart: convertOcifArrowheadToTldraw(primaryData.startMarker),
					arrowheadEnd: convertOcifArrowheadToTldraw(primaryData.endMarker),
					start: { x: primaryData.start[0], y: primaryData.start[1] },
					end: { x: primaryData.end[0], y: primaryData.end[1] },
					bend: 0,
					richText: primaryData.text ? toRichText(primaryData.text) : toRichText(''),
					labelPosition: primaryData.labelPosition ?? 0.5,
					labelColor: primaryData.labelColor
						? convertHexToTldrawColor(primaryData.labelColor)
						: 'black',
					fill: 'none',
					dash: 'draw',
					font: 'draw',
					scale: scale,
					elbowMidPoint: 0,
				},
			} as any

		case '@tldraw/node/image': {
			// Legacy image node support
			const assetId = node.resource ? assetMap.get(node.resource) : null
			const altText = node.resource ? altTextMap.get(node.resource) || '' : ''
			if (assetId) {
				return {
					...baseShape,
					type: 'image',
					props: {
						assetId: assetId,
						w,
						h,
						playing: true,
						url: '',
						crop: primaryData.crop || null,
						flipX: false,
						flipY: false,
						altText: altText,
					},
				} as any
			}
			break
		}

		case '@tldraw/node/note': {
			// Note (sticky note) support
			const props: any = {
				richText: toRichText(primaryData.text || ''),
				color: convertHexToTldrawColor(primaryData.color || '#000000'),
				labelColor: convertHexToTldrawColor(
					primaryData.labelColor || primaryData.color || '#000000'
				),
				size: convertPixelsToTldrawSize((primaryData.fontSizePx || 16) / 4),
				font: convertCSSFontToTldraw(primaryData.fontFamily || 'draw'),
				align: primaryData.align || 'middle',
				verticalAlign: primaryData.verticalAlign || 'middle',
				growY: primaryData.growY || 0,
				url: primaryData.url || '',
				// Let tldraw recompute the auto-fit font size from `size`.
				fontSizeAdjustment: 0,
				scale: scale,
				textLastEditedBy: null,
			}

			return {
				...baseShape,
				type: 'note',
				props,
			} as any
		}

		case '@tldraw/node/video': {
			// Legacy video node support - now handled like images
			const assetId = node.resource ? assetMap.get(node.resource) : null
			const altText = node.resource ? altTextMap.get(node.resource) || '' : ''
			if (assetId) {
				return {
					...baseShape,
					type: 'video',
					props: {
						assetId: assetId,
						w,
						h,
						time: 0,
						playing: true,
						autoplay: true,
						url: '',
						altText: altText,
					},
				} as any
			}
			break
		}

		case '@tldraw/node/embed': {
			// Embed support
			return {
				...baseShape,
				type: 'embed',
				props: {
					w: primaryData.w || w,
					h: primaryData.h || h,
					url: primaryData.url || '',
				},
			} as any
		}

		case '@tldraw/node/bookmark': {
			// Bookmark support
			const assetId = primaryData.assetId ? assetMap.get(primaryData.assetId) : null
			if (assetId) {
				return {
					...baseShape,
					type: 'bookmark',
					props: {
						w,
						h,
						assetId: assetId,
						url: primaryData.url || '',
					},
				} as any
			}
			break
		}

		case '@tldraw/node/highlight': {
			// Highlight support
			const segments = convertSvgPathToDrawSegments(primaryData.path || '')
			const props: any = {
				segments,
				color: convertHexToTldrawColor(primaryData.color || '#000000'),
				size: convertPixelsToTldrawSize(primaryData.size || 4),
				isComplete: primaryData.isComplete || false,
				isPen: false,
				scale: scale,
				scaleX: 1,
				scaleY: 1,
			}

			return {
				...baseShape,
				type: 'highlight',
				props,
			} as any
		}

		default:
			// For unknown types, create a basic geo shape
			return {
				...baseShape,
				type: 'geo',
				props: {
					geo: 'rectangle',
					color: 'black',
					fill: 'none',
					size: 'm',
					w,
					h,
					growY: 0,
					font: 'draw',
					align: 'middle',
					verticalAlign: 'middle',
					url: '',
					dash: 'draw',
					labelColor: 'black',
					scale: scale,
					richText: toRichText(''),
					flipX: false,
					flipY: false,
				},
			} as any
	}

	return null
}

// ---------------------------------------------------------------------------
// Color conversion helpers
// ---------------------------------------------------------------------------

const TLDRAW_COLOR_HEX: Array<[string, string]> = [
	['black', '#000000'],
	['grey', '#808080'],
	['white', '#FFFFFF'],
	['blue', '#0066CC'],
	['green', '#00AA00'],
	['yellow', '#FFDD00'],
	['orange', '#FF8800'],
	['red', '#FF0000'],
	['violet', '#8800FF'],
	['light-blue', '#66CCFF'],
	['light-green', '#88FF88'],
	['light-red', '#FF8888'],
	['light-violet', '#CC88FF'],
]

function convertTldrawColorToHex(color: string): string {
	return TLDRAW_COLOR_HEX.find(([name]) => name === color)?.[1] || '#000000'
}

/** Parse #RGB, #RRGGBB, or #RRGGBBAA hex (case-insensitive). */
function parseHexColor(hex: string): { r: number; g: number; b: number; a: number } | null {
	if (typeof hex !== 'string') return null
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
	if (!match) return null
	let digits = match[1]
	if (digits.length === 3) {
		digits = digits
			.split('')
			.map((c) => c + c)
			.join('')
	}
	const r = parseInt(digits.slice(0, 2), 16)
	const g = parseInt(digits.slice(2, 4), 16)
	const b = parseInt(digits.slice(4, 6), 16)
	const a = digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1
	return { r, g, b, a }
}

function convertHexToTldrawColor(hex: string): string {
	const rgb = parseHexColor(hex)
	if (!rgb) return 'black'

	// Nearest palette color by squared RGB distance, so lowercase hex and
	// colors from other OCIF apps still map to something sensible.
	let bestName = 'black'
	let bestDistance = Infinity
	for (const [name, paletteHex] of TLDRAW_COLOR_HEX) {
		const p = parseHexColor(paletteHex)!
		const distance = (p.r - rgb.r) ** 2 + (p.g - rgb.g) ** 2 + (p.b - rgb.b) ** 2
		if (distance < bestDistance) {
			bestDistance = distance
			bestName = name
		}
	}
	return bestName
}

function convertTldrawFillToHex(fill: string, color: string): string {
	if (fill === 'none') return 'transparent'
	if (fill === 'solid') return convertTldrawColorToHex(color)
	// For semi-fills, use a transparent version
	const baseColor = convertTldrawColorToHex(color)
	return baseColor + '80' // Add transparency
}

function convertHexToTldrawFill(hex: string): string {
	if (!hex || hex === 'transparent' || hex === 'none') return 'none'
	const rgb = parseHexColor(hex)
	if (rgb && rgb.a === 0) return 'none'
	if (rgb && rgb.a < 1) return 'semi'
	return 'solid'
}

function convertTldrawSizeToPixels(size: string): number {
	const sizeMap: { [key: string]: number } = {
		s: 2,
		m: 4,
		l: 8,
		xl: 12,
	}
	return sizeMap[size] || 2
}

function convertTldrawArrowheadToOcif(arrowhead: string): string {
	const arrowheadMap: { [key: string]: string } = {
		none: 'none',
		arrow: 'arrowhead',
		triangle: 'triangle',
		square: 'square',
		dot: 'dot',
		pipe: 'pipe',
		diamond: 'diamond',
		inverted: 'inverted',
		bar: 'bar',
	}
	return arrowheadMap[arrowhead] || 'none'
}

function convertTldrawFontToCSS(font: string): string {
	const fontMap: { [key: string]: string } = {
		sans: 'sans-serif',
		serif: 'serif',
		mono: 'monospace',
		draw: 'draw',
	}
	return fontMap[font] || 'draw'
}

function convertTldrawTextAlignToOcif(align: string): string {
	const alignMap: { [key: string]: string } = {
		start: 'left',
		middle: 'middle',
		end: 'right',
		left: 'left',
		center: 'center',
		right: 'right',
	}
	return alignMap[align] || 'left'
}

function convertTldrawTextAlignToOcifStyle(align: string): string {
	const alignMap: { [key: string]: string } = {
		start: 'left',
		middle: 'center',
		end: 'right',
		left: 'left',
		center: 'center',
		right: 'right',
	}
	return alignMap[align] || 'left'
}

function convertPixelsToTldrawSize(pixels: number): string {
	if (pixels <= 2) return 's'
	if (pixels <= 4) return 'm'
	if (pixels <= 8) return 'l'
	return 'xl'
}

function convertOcifArrowheadToTldraw(arrowhead: string): string {
	const arrowheadMap: { [key: string]: string } = {
		none: 'none',
		arrowhead: 'arrow',
		triangle: 'triangle',
		square: 'square',
		dot: 'circle',
		pipe: 'line',
		diamond: 'diamond',
		triangle_inverted: 'triangle-open',
	}
	return arrowheadMap[arrowhead] || 'none'
}

function convertCSSFontToTldraw(font: string): string {
	const fontMap: { [key: string]: string } = {
		'sans-serif': 'sans',
		serif: 'serif',
		monospace: 'mono',
	}
	return fontMap[font] || 'draw'
}

function convertOcifTextAlignToTldraw(align: string): string {
	const alignMap: { [key: string]: string } = {
		start: 'start',
		middle: 'middle',
		end: 'end',
		left: 'start',
		center: 'middle',
		right: 'end',
	}
	return alignMap[align] || 'start'
}

// ---------------------------------------------------------------------------
// SVG path ↔ draw segments
// ---------------------------------------------------------------------------

function convertDrawSegmentsToSvgPath(segments: any[]): string {
	// Convert tldraw draw segments to SVG path string
	if (!segments || segments.length === 0) return ''

	let path = ''
	for (const segment of segments) {
		const points = segmentToPoints(segment)
		if (points.length === 0) continue

		const firstPoint = points[0]
		path += `M${round2(firstPoint.x)},${round2(firstPoint.y)}`

		for (let i = 1; i < points.length; i++) {
			const point = points[i]
			path += `L${round2(point.x)},${round2(point.y)}`
		}
	}

	return path
}

function round2(n: number): number {
	return Math.round(n * 100) / 100
}

/**
 * Parse an SVG path string into subpaths of absolute points. Supports the
 * common command set; curve commands contribute their endpoints.
 */
function parseSvgPathToSubpaths(svgPath: string): Array<Array<{ x: number; y: number }>> {
	const subpaths: Array<Array<{ x: number; y: number }>> = []
	let current: Array<{ x: number; y: number }> = []
	let cx = 0
	let cy = 0

	const commandRe = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g
	let match: RegExpExecArray | null
	while ((match = commandRe.exec(svgPath)) !== null) {
		const command = match[1]
		const args = (match[2].trim().match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number)
		const isRelative = command === command.toLowerCase()

		const push = () => current.push({ x: cx, y: cy })

		switch (command.toUpperCase()) {
			case 'M': {
				if (current.length > 0) subpaths.push(current)
				current = []
				for (let i = 0; i + 1 < args.length; i += 2) {
					cx = isRelative ? cx + args[i] : args[i]
					cy = isRelative ? cy + args[i + 1] : args[i + 1]
					push()
				}
				break
			}
			case 'L':
			case 'T': {
				for (let i = 0; i + 1 < args.length; i += 2) {
					cx = isRelative ? cx + args[i] : args[i]
					cy = isRelative ? cy + args[i + 1] : args[i + 1]
					push()
				}
				break
			}
			case 'H': {
				for (const arg of args) {
					cx = isRelative ? cx + arg : arg
					push()
				}
				break
			}
			case 'V': {
				for (const arg of args) {
					cy = isRelative ? cy + arg : arg
					push()
				}
				break
			}
			case 'C': {
				for (let i = 0; i + 5 < args.length; i += 6) {
					cx = isRelative ? cx + args[i + 4] : args[i + 4]
					cy = isRelative ? cy + args[i + 5] : args[i + 5]
					push()
				}
				break
			}
			case 'S':
			case 'Q': {
				for (let i = 0; i + 3 < args.length; i += 4) {
					cx = isRelative ? cx + args[i + 2] : args[i + 2]
					cy = isRelative ? cy + args[i + 3] : args[i + 3]
					push()
				}
				break
			}
			case 'A': {
				for (let i = 0; i + 6 < args.length; i += 7) {
					cx = isRelative ? cx + args[i + 5] : args[i + 5]
					cy = isRelative ? cy + args[i + 6] : args[i + 6]
					push()
				}
				break
			}
			case 'Z':
				break
		}
	}
	if (current.length > 0) subpaths.push(current)

	return subpaths
}

function convertSvgPathToDrawSegments(svgPath: string): any[] {
	// tldraw 5.x stores segment points as delta-encoded base64 (see b64Vecs).
	const subpaths = parseSvgPathToSubpaths(svgPath || '')
		// A draw segment needs at least two points to render a stroke.
		.map((points) => (points.length === 1 ? [points[0], points[0]] : points))
		.filter((points) => points.length >= 2)

	if (subpaths.length === 0) {
		return [
			{
				type: 'free',
				path: b64Vecs.encodePoints([
					{ x: 0, y: 0, z: 0.5 },
					{ x: 1, y: 1, z: 0.5 },
				]),
			},
		]
	}

	return subpaths.map((points) => ({
		type: 'free',
		path: b64Vecs.encodePoints(points.map((p) => ({ x: p.x, y: p.y, z: 0.5 }))),
	}))
}

// ---------------------------------------------------------------------------
// OCIF schemas registry
// ---------------------------------------------------------------------------

function getOcifSchemas(): OcifSchema[] {
	return [
		{
			name: '@ocif/rect',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/rect.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/rect' },
					strokeColor: { type: 'string', default: '#FFFFFF' },
					fillColor: { type: 'string' },
					strokeWidth: { type: 'number', default: 1 },
				},
			},
		},
		{
			name: '@ocif/oval',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/oval.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/oval' },
					strokeColor: { type: 'string', default: '#FFFFFF' },
					fillColor: { type: 'string' },
					strokeWidth: { type: 'number', default: 1 },
				},
			},
		},
		{
			name: '@ocif/path',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/path.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/path' },
					strokeColor: { type: 'string', default: '#FFFFFF' },
					fillColor: { type: 'string' },
					strokeWidth: { type: 'number', default: 1 },
					path: { type: 'string' },
				},
			},
		},
		{
			name: '@ocif/arrow',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/arrow.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/arrow' },
					strokeColor: { type: 'string', default: '#FFFFFF' },
					strokeWidth: { type: 'number', default: 1 },
					start: { type: 'array', items: { type: 'number' } },
					end: { type: 'array', items: { type: 'number' } },
					startMarker: { type: 'string', default: 'none' },
					endMarker: { type: 'string', default: 'none' },
				},
			},
		},
		{
			name: '@ocif/edge',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/edge.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/edge' },
					start: { type: 'string' },
					end: { type: 'string' },
					directed: { type: 'boolean', default: true },
					rel: { type: 'string' },
				},
			},
		},
		{
			name: '@ocif/group',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/group.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/group' },
					members: { type: 'array', items: { type: 'string' } },
					cascadeDelete: { type: 'boolean' },
				},
			},
		},
		{
			name: '@ocif/hyperedge',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/hyperedge.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/hyperedge' },
					endpoints: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								direction: { type: 'string', enum: ['in', 'out', 'undir'], default: 'undir' },
								weight: { type: 'number', default: 1.0 },
							},
						},
					},
					weight: { type: 'number', default: 1.0 },
					rel: { type: 'string' },
				},
			},
		},
		{
			name: '@ocif/textstyle',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/textstyle.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/textstyle' },
					fontSizePx: { type: 'number', default: 12 },
					fontFamily: { type: 'string', default: 'sans-serif' },
					color: { type: 'string', default: '#000000' },
					align: { type: 'string', enum: ['left', 'right', 'center', 'justify'], default: 'left' },
					bold: { type: 'boolean', default: false },
					italic: { type: 'boolean', default: false },
				},
			},
		},
		{
			name: '@ocif/ports',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/ports.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/ports' },
					ports: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		{
			name: '@ocif/inherit',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/inherit.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/inherit' },
					inheritFrom: { type: 'string' },
					include: { type: 'array', items: { type: 'string' } },
					exclude: { type: 'array', items: { type: 'string' } },
				},
			},
		},
		{
			name: '@ocif/global-positions',
			uri: 'https://spec.canvasprotocol.org/v0.7.0/extensions/global-positions.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@ocif/global-positions' },
					globalPosition: { type: 'array', items: { type: 'number' } },
					globalSize: { type: 'array', items: { type: 'number' } },
					globalRotation: { type: 'number', default: 0 },
				},
			},
		},
		// Custom tldraw extensions
		{
			name: '@tldraw/node/note',
			uri: 'https://tldraw.com/schemas/note-node.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@tldraw/node/note' },
					text: { type: 'string' },
					color: { type: 'string' },
					labelColor: { type: 'string' },
					fontSizePx: { type: 'number' },
					fontFamily: { type: 'string' },
					align: { type: 'string' },
					verticalAlign: { type: 'string' },
					growY: { type: 'number' },
					url: { type: 'string' },
				},
			},
		},
		{
			name: '@tldraw/node/embed',
			uri: 'https://tldraw.com/schemas/embed-node.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@tldraw/node/embed' },
					url: { type: 'string' },
					w: { type: 'number' },
					h: { type: 'number' },
				},
			},
		},
		{
			name: '@tldraw/node/bookmark',
			uri: 'https://tldraw.com/schemas/bookmark-node.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@tldraw/node/bookmark' },
					assetId: { type: 'string' },
					url: { type: 'string' },
					title: { type: 'string' },
					description: { type: 'string' },
					favicon: { type: 'string' },
					image: { type: 'string' },
				},
			},
		},
		{
			name: '@tldraw/node/highlight',
			uri: 'https://tldraw.com/schemas/highlight-node.json',
			schema: {
				type: 'object',
				properties: {
					type: { const: '@tldraw/node/highlight' },
					path: { type: 'string' },
					color: { type: 'string' },
					size: { type: 'number' },
					isComplete: { type: 'boolean' },
				},
			},
		},
	]
}

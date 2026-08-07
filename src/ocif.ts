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
// Rich-text helper
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a tldraw rich text (TipTap / ProseMirror JSON) object.
 *
 * We keep our own lightweight implementation so that we don't depend on
 * internal tldraw utilities that may not be exported from the public API.
 */
function renderPlaintextFromRichText(_editor: Editor, richText: any): string {
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
	data: Array<{
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
	const records = editor.store.allRecords()
	const nodes: OcifNode[] = []
	const resources: OcifResource[] = []
	const usedSchemaTypes = new Set<string>()

	// Build a map of arrow shape IDs → their bindings for edge extensions
	const arrowBindings = new Map<string, Array<{ fromId: string; toId: string; bindingId: string }>>()
	for (const record of records) {
		if (record.typeName === 'binding' && (record as any).type === 'arrow') {
			const binding = record as any
			const fromId = binding.fromId
			if (!arrowBindings.has(fromId)) {
				arrowBindings.set(fromId, [])
			}
			arrowBindings.get(fromId)!.push({
				fromId: binding.fromId,
				toId: binding.toId,
				bindingId: binding.id,
			})
		}
	}

	// Collect group membership: groupId → memberIds
	const groupsToMembers = new Map<string, string[]>()
	for (const record of records) {
		if (
			record.typeName === 'shape' &&
			(record as any).parentId &&
			(record as any).parentId !== editor.getCurrentPageId()
		) {
			const parentShape = editor.getShape((record as any).parentId)
			if (parentShape?.type === 'group') {
				const groupId = (record as any).parentId
				if (!groupsToMembers.has(groupId)) {
					groupsToMembers.set(groupId, [])
				}
				groupsToMembers.get(groupId)!.push(record.id)
			}
		}
	}

	// Convert shapes to nodes
	for (const record of records) {
		if (record.typeName === 'shape') {
			const shape = record as any

			// Groups become nodes with @ocif/group extension
			if (shape.type === 'group') {
				const members = groupsToMembers.get(shape.id)
				if (members && members.length > 0) {
					const groupNode: OcifNode = {
						id: shape.id,
						position: [shape.x, shape.y],
						data: [
							{
								type: '@ocif/group',
								members,
								cascadeDelete: true,
							},
						],
					}
					nodes.push(groupNode)
					usedSchemaTypes.add('@ocif/group')
				}
				continue
			}

			const node = convertTldrawShapeToOcifNode(shape, editor)
			if (node) {
				// Add edge extensions for arrow bindings
				const bindings = arrowBindings.get(shape.id)
				if (bindings) {
					for (const b of bindings) {
						node.data.push({
							type: '@ocif/edge',
							start: b.fromId,
							end: b.toId,
						})
						usedSchemaTypes.add('@ocif/edge')
					}
				}

				// Set parent property for frame/group containment
				if (shape.parentId && shape.parentId !== editor.getCurrentPageId()) {
					const parentShape = editor.getShape(shape.parentId)
					if (parentShape) {
						node.parent = shape.parentId
					}
				}

				nodes.push(node)
				node.data.forEach((d) => usedSchemaTypes.add(d.type))
			}
		}
	}

	// Collect referenced resources
	const referencedResourceIds = new Set<string>()
	for (const node of nodes) {
		if (node.resource) referencedResourceIds.add(node.resource)
		for (const d of node.data) {
			if (d.assetId) referencedResourceIds.add(d.assetId)
		}
	}

	for (const record of records) {
		if (record.typeName === 'asset' && referencedResourceIds.has(record.id)) {
			const resource = await convertTldrawAssetToOcifResource(record as any, editor)
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

	if (!data.ocif.includes('v0.7')) {
		return Result.err({ type: 'ocifVersionNotSupported', version: data.ocif })
	}

	try {
		const records: TLRecord[] = []
		const assetMap = new Map<string, string>()
		const altTextMap = new Map<string, string>()
		const groupRelations = new Map<string, string[]>()
		const parentChildRelations = new Map<string, string>()
		const hyperedgeNodes: OcifNode[] = []
		const edgeRelations: Array<{ nodeId: string; start: string; end: string }> = []

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

			for (const d of node.data) {
				if (d.type === '@ocif/group') {
					groupRelations.set(node.id, d.members || [])
				} else if (d.type === '@ocif/edge') {
					edgeRelations.push({ nodeId: node.id, start: d.start, end: d.end })
				} else if (d.type === '@ocif/hyperedge') {
					hyperedgeNodes.push(node)
				}
			}
		}

		// Convert OCIF nodes to TLDraw shapes
		const structuralOnlyTypes = new Set(['@ocif/group', '@ocif/hyperedge', '@ocif/edge', '@ocif/inherit'])
		for (const node of data.nodes ?? []) {
			// Skip nodes that are purely structural (no visual representation)
			const isStructuralOnly = node.data.length > 0 && node.data.every((d) => structuralOnlyTypes.has(d.type))
			if (isStructuralOnly) continue

			const shapeRecord = convertOcifNodeToTldrawShape(node, assetMap, altTextMap, resourceTypeMap)
			if (shapeRecord) {
				const parentId = parentChildRelations.get(node.id)
				if (parentId) {
					const parentShapeId = parentId.startsWith('shape:') ? parentId : `shape:${parentId}`
					;(shapeRecord as any).parentId = parentShapeId
				}
				records.push(shapeRecord)
			}
		}

		// Create frame shapes from parent-child relations
		const frameIds = new Set<string>()
		for (const [_childId, parentId] of parentChildRelations) {
			if (!frameIds.has(parentId)) {
				frameIds.add(parentId)
				const parentNode = (data.nodes ?? []).find((n) => n.id === parentId)
				if (parentNode) {
					const frameData = parentNode.data.find((d) => d.isFrame)
					if (frameData) {
						const frameShapeId = parentId.startsWith('shape:') ? parentId : `shape:${parentId}`
						const pos = parentNode.position ?? [0, 0]
						const frameShape = {
							id: frameShapeId,
							typeName: 'shape' as const,
							type: 'frame',
							x: pos[0],
							y: pos[1],
							rotation: parentNode.rotation || 0,
							index: 'a1' as any,
							parentId: 'page:page' as any,
							isLocked: false,
							opacity: 1,
							meta: {},
							props: {
								w: parentNode.size?.[0] || 200,
								h: parentNode.size?.[1] || 200,
								name: frameData.frameName || '',
								color: convertHexToTldrawColor(frameData.strokeColor || '#000000'),
							},
						} as any
						records.push(frameShape)
					}
				}
			}
		}

		// Create group shapes and set up parent-child relationships
		for (const [groupId, memberIds] of groupRelations) {
			const groupShapeId = groupId.startsWith('shape:') ? groupId : `shape:${groupId}`

			let minX = Infinity,
				minY = Infinity,
				maxX = -Infinity,
				maxY = -Infinity
			const memberShapes = memberIds
				.map((id) => {
					const shapeId = id.startsWith('shape:') ? id : `shape:${id}`
					return records.find((r) => r.id === shapeId && r.typeName === 'shape') as any
				})
				.filter(Boolean)

			for (const shape of memberShapes) {
				minX = Math.min(minX, shape.x)
				minY = Math.min(minY, shape.y)
				maxX = Math.max(maxX, shape.x + (shape.props.w || 100))
				maxY = Math.max(maxY, shape.y + (shape.props.h || 100))
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

				for (const shape of memberShapes) {
					shape.parentId = groupShapeId
					shape.x -= groupX
					shape.y -= groupY
				}
			}
		}

		// Process hyperedge nodes
		for (const hyperedge of hyperedgeNodes) {
			const heData = hyperedge.data.find((d) => d.type === '@ocif/hyperedge')
			if (heData?.endpoints) {
				const endpoints = heData.endpoints
				const inEndpoints = endpoints.filter((ep: any) => ep.direction === 'in')
				const outEndpoints = endpoints.filter((ep: any) => ep.direction === 'out')
				const undirEndpoints = endpoints.filter((ep: any) => ep.direction === 'undir')

				if (inEndpoints.length > 0 && outEndpoints.length > 0) {
					for (let i = 0; i < Math.max(inEndpoints.length, outEndpoints.length); i++) {
						const inEp = inEndpoints[i % inEndpoints.length]
						const outEp = outEndpoints[i % outEndpoints.length]
						const inId = inEp.id.startsWith('shape:') ? inEp.id : `shape:${inEp.id}`
						const outId = outEp.id.startsWith('shape:') ? outEp.id : `shape:${outEp.id}`
						records.push({
							id: `binding:hyperedge-${hyperedge.id}-${i}`,
							typeName: 'binding' as const,
							type: 'arrow',
							fromId: inId,
							toId: outId,
							meta: {},
							props: {
								terminal: 'end',
								normalizedAnchor: { x: 0.5, y: 0.5 },
								isExact: false,
								isPrecise: false,
								snap: 'none',
							},
						} as any)
					}
				}

				for (let i = 0; i < undirEndpoints.length - 1; i++) {
					const ep1Id = undirEndpoints[i].id.startsWith('shape:') ? undirEndpoints[i].id : `shape:${undirEndpoints[i].id}`
					const ep2Id = undirEndpoints[i + 1].id.startsWith('shape:') ? undirEndpoints[i + 1].id : `shape:${undirEndpoints[i + 1].id}`
					records.push({
						id: `binding:hyperedge-undir-${hyperedge.id}-${i}`,
						typeName: 'binding' as const,
						type: 'arrow',
						fromId: ep1Id,
						toId: ep2Id,
						meta: {},
						props: {
							terminal: 'end',
							normalizedAnchor: { x: 0.5, y: 0.5 },
							isExact: false,
							isPrecise: false,
							snap: 'none',
						},
					} as any)
				}
			}
		}

		// Convert edge extensions to tldraw bindings
		let edgeIndex = 0
		for (const edge of edgeRelations) {
			const bindingId = `binding:edge-${edge.nodeId}-${edgeIndex++}`
			const fromId = edge.start.startsWith('shape:') ? edge.start : `shape:${edge.start}`
			const toId = edge.end.startsWith('shape:') ? edge.end : `shape:${edge.end}`
			records.push({
				id: bindingId,
				typeName: 'binding',
				type: 'arrow',
				fromId,
				toId,
				meta: {},
				props: {
					terminal: 'end',
					normalizedAnchor: { x: 0.5, y: 0.5 },
					isExact: false,
					isPrecise: false,
					snap: 'none',
				},
			} as any)
		}

		// Filter out any records that might be invalid or have broken references
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
				const fromShape = records.find((r) => r.id === binding.fromId && r.typeName === 'shape')
				const toShape = records.find((r) => r.id === binding.toId && r.typeName === 'shape')
				return fromShape && toShape
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

/** @public */
export async function parseAndLoadOcifFile(
	editor: Editor,
	document: string,
	msg: (id: any) => string,
	addToast: any,
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
				description = msg('file-system.file-open-error.not-a-tldraw-file')
				break
			case 'ocifVersionNotSupported':
				description = msg('file-system.file-open-error.file-format-version-too-new')
				break
			case 'invalidOcifStructure':
				console.error('[tldraw-ocif] Invalid OCIF structure', parseFileResult.error.cause)
				description = msg('file-system.file-open-error.generic-corrupted-file')
				break
			default:
				description = msg('file-system.file-open-error.generic-corrupted-file')
				break
		}
		addToast({
			title: msg('file-system.file-open-error.title'),
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

		extractAndResolveAssets(editor, snapshot)

		const bounds = editor.getCurrentPageBounds()
		if (bounds) {
			editor.zoomToBounds(bounds, { targetZoom: 1, immediate: true })
		}
	})

	if (forceDarkMode) editor.user.updateUserPreferences({ colorScheme: 'dark' })
}

// ---------------------------------------------------------------------------
// Internal: asset extraction (simplified from tldraw's extractAssets)
// ---------------------------------------------------------------------------

async function extractAndResolveAssets(editor: Editor, snapshot: any) {
	const records = snapshot.store ? Object.values(snapshot.store) : Object.values(snapshot)

	for (const record of records as any[]) {
		if (
			record.typeName === 'asset' &&
			record.props.src &&
			record.props.src.startsWith('data:') &&
			(record.type === 'image' || record.type === 'video')
		) {
			// Data URIs are already embedded – nothing to resolve for portability.
			// If the host app has an asset upload handler the consumer can call
			// editor.uploadAsset() themselves after loading.
		}
	}
}

// ---------------------------------------------------------------------------
// Internal helpers – tldraw shape → OCIF node
// ---------------------------------------------------------------------------

function calculateDrawShapeSize(segments: any[]): [number, number] {
	if (!segments || segments.length === 0) {
		return [100, 100]
	}

	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity

	for (const segment of segments) {
		if (segment.points && segment.points.length > 0) {
			for (const point of segment.points) {
				minX = Math.min(minX, point.x)
				minY = Math.min(minY, point.y)
				maxX = Math.max(maxX, point.x)
				maxY = Math.max(maxY, point.y)
			}
		}
	}

	if (minX === Infinity || minY === Infinity || maxX === -Infinity || maxY === -Infinity) {
		return [100, 100]
	}

	return [Math.max(maxX - minX, 10), Math.max(maxY - minY, 10)]
}

function convertTldrawShapeToOcifNode(shape: any, editor: Editor): OcifNode | null {
	const position: [number, number] = [shape.x, shape.y]

	let size: [number, number]
	if (shape.type === 'draw') {
		size = calculateDrawShapeSize(shape.props.segments)
	} else if (shape.type === 'text') {
		size = [shape.props.w || 100, shape.props.h || 100]
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

			if (shape.props.text && shape.props.text.trim()) {
				nodeData.text =
					renderPlaintextFromRichText(editor, shape.props.richText) || shape.props.text
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
				text: shape.props.richText
					? renderPlaintextFromRichText(editor, shape.props.richText)
					: shape.props.text || '',
				textColor: convertTldrawColorToHex(shape.props.color),
				fontSize: convertTldrawSizeToPixels(shape.props.size) * 4,
				fontFamily: shape.props.font || 'draw',
				textAlign: convertTldrawTextAlignToOcif(shape.props.textAlign || 'start'),
			}

			data.push(textNodeData)

			data.push({
				type: '@ocif/textstyle',
				fontSizePx: convertTldrawSizeToPixels(shape.props.size) * 4,
				fontFamily: convertTldrawFontToCSS(shape.props.font || 'draw'),
				color: convertTldrawColorToHex(shape.props.color),
				align: convertTldrawTextAlignToOcifStyle(shape.props.textAlign || 'start'),
				bold: false,
				italic: false,
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

			const arrowText = renderPlaintextFromRichText(editor, shape.props.richText)
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
		case 'image': {
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
				text: shape.props.richText
					? renderPlaintextFromRichText(editor, shape.props.richText)
					: '',
				color: convertTldrawColorToHex(shape.props.color),
				labelColor: convertTldrawColorToHex(shape.props.labelColor || shape.props.color),
				fontSizePx: shape.props.fontSizeAdjustment,
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
				const asset = editor.getAsset(shape.props.assetId)
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
	editor: Editor
): Promise<OcifResource | null> {
	if (asset.type === 'image' || asset.type === 'video') {
		const representations: OcifRepresentation[] = []

		// Always inline the data as base64 for portability (same as TLDR export)
		let assetSrcToSave = asset.props.src
		if (asset.props.src && !asset.props.src.startsWith('data:')) {
			try {
				let src = asset.props.src
				if (!src.startsWith('http')) {
					src = (await editor.resolveAssetUrl(asset.id, { shouldResolveToOriginal: true })) || ''
				}
				// Convert to base64 data URL for portability (same as TLDR export)
				assetSrcToSave = await FileHelpers.blobToDataUrl(await (await fetch(src)).blob())
			} catch {
				// If conversion fails, keep the original src
				assetSrcToSave = asset.props.src
			}
		}

		if (assetSrcToSave) {
			representations.push({
				content: assetSrcToSave, // Always use content (base64) for portability
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
	// Create a basic asset from the OCIF resource
	const id = AssetRecordType.createId(resource.id)

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

	const textStyleExtension = node.data.find((d) => d.type === '@ocif/textstyle')

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
	if (node.data.length === 0 && node.resource) {
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
	const primaryData = node.data[0]
	if (!primaryData) return null

	switch (primaryData.type) {
		case '@ocif/rect':
			if (primaryData.text && primaryData.strokeColor === 'transparent' && primaryData.strokeWidth === 0) {
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
			} else if (primaryData.isFrame) {
				// This is a frame node - will be handled separately
				return null
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
					flipX: false,
					flipY: false,
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
				flipX: false,
				flipY: false,
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
				fontSizeAdjustment: primaryData.fontSizePx !== undefined ? primaryData.fontSizePx : 0,
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

function convertTldrawColorToHex(color: string): string {
	const colorMap: { [key: string]: string } = {
		black: '#000000',
		grey: '#808080',
		white: '#FFFFFF',
		blue: '#0066CC',
		green: '#00AA00',
		yellow: '#FFDD00',
		orange: '#FF8800',
		red: '#FF0000',
		violet: '#8800FF',
		'light-blue': '#66CCFF',
		'light-green': '#88FF88',
		'light-red': '#FF8888',
		'light-violet': '#CC88FF',
	}
	return colorMap[color] || '#000000'
}

function convertTldrawFillToHex(fill: string, color: string): string {
	if (fill === 'none') return 'transparent'
	if (fill === 'solid') return convertTldrawColorToHex(color)
	// For semi-fills, use a transparent version
	const baseColor = convertTldrawColorToHex(color)
	return baseColor + '80' // Add transparency
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

function convertHexToTldrawColor(hex: string): string {
	const colorMap: { [key: string]: string } = {
		'#000000': 'black',
		'#808080': 'grey',
		'#FFFFFF': 'white',
		'#0066CC': 'blue',
		'#00AA00': 'green',
		'#00FF00': 'green',
		'#FFDD00': 'yellow',
		'#FF8800': 'orange',
		'#FF0000': 'red',
		'#8800FF': 'violet',
		'#66CCFF': 'light-blue',
		'#88FF88': 'light-green',
		'#FF8888': 'light-red',
		'#CC88FF': 'light-violet',
	}
	return colorMap[hex] || 'black'
}

function convertHexToTldrawFill(hex: string): string {
	if (hex === 'transparent' || !hex) return 'none'
	if (hex.endsWith('80') || hex.includes('alpha')) return 'semi'
	return 'solid'
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
		if (!segment.points || segment.points.length === 0) continue

		const firstPoint = segment.points[0]
		path += `M${firstPoint.x},${firstPoint.y}`

		for (let i = 1; i < segment.points.length; i++) {
			const point = segment.points[i]
			if (segment.type === 'straight') {
				path += `L${point.x},${point.y}`
			} else {
				// For free-form segments, use line-to for simplicity
				path += `L${point.x},${point.y}`
			}
		}
	}

	return path
}

function convertSvgPathToDrawSegments(svgPath: string): any[] {
	// In tldraw 4.x, segments use a `path` string instead of `points` array.
	const fallbackPath = 'M0,0 L50,25 L100,0'

	if (!svgPath || svgPath.length === 0) {
		return [{ type: 'free', path: fallbackPath }]
	}

	// The SVG path is already in the right format — wrap it in a segment.
	return [{ type: 'free', path: svgPath }]
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

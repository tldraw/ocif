import { AssetRecordType, createTLSchema, toRichText } from 'tldraw'
import { describe, expect, it } from 'vitest'
import {
	OCIF_FILE_EXTENSION,
	OCIF_FILE_MIMETYPE,
	parseOcifFile,
	type OcifFile,
} from '../ocif'

// We use createTLSchema() for parse tests — no headless Editor needed.
const schema = createTLSchema()

describe('OCIF', () => {
	describe('Constants', () => {
		it('should have correct MIME type', () => {
			expect(OCIF_FILE_MIMETYPE).toBe('application/vnd.ocif+json')
		})

		it('should have correct file extension', () => {
			expect(OCIF_FILE_EXTENSION).toBe('.ocif.json')
		})
	})

	describe('OCIF v0.6 specification compliance', () => {
		describe('Header (ocif property)', () => {
			it('should accept correct OCIF version header', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [],
				})

				const result = parseOcifFile({ json: testOcif, schema })
				expect(result.ok).toBe(true)
			})
		})

		describe('Nodes structure', () => {
			it('should support resourceFit property in nodes and create correct shapes', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'node1',
							position: [10, 20],
							size: [100, 80],
							resource: 'resource1',
							resourceFit: 'contain',
							rotation: Math.PI / 6,
							data: [{ type: '@ocif/node/rect', strokeColor: '#FF0000' }],
						},
					],
					resources: [
						{
							id: 'resource1',
							representations: [
								{
									content: 'data:image/png;base64,iVBOR...',
									mimeType: 'image/png',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })

				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())

					const shapes = records.filter((r) => r.typeName === 'shape')
					expect(shapes).toHaveLength(1)

					const shape = shapes[0] as any
					expect(shape.id).toBe('shape:node1')
					expect(shape.x).toBe(10)
					expect(shape.y).toBe(20)
					expect(shape.rotation).toBeCloseTo(Math.PI / 6)
					expect(shape.props.w).toBe(100)
					expect(shape.props.h).toBe(80)

					const assets = records.filter((r) => r.typeName === 'asset')
					expect(assets).toHaveLength(1)

					const asset = assets[0] as any
					expect(asset.props.src).toBe('data:image/png;base64,iVBOR...')
					expect(asset.props.mimeType).toBe('image/png')
				}
			})

			it('should support relation property in nodes and create correct shapes', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'node1',
							position: [0, 0],
							size: [50, 50],
							data: [{ type: '@ocif/node/rect', strokeColor: '#00FF00', fillColor: 'transparent' }],
							relation: 'relation1',
						},
					],
					relations: [
						{
							id: 'relation1',
							node: 'node1',
							data: [
								{
									type: '@ocif/rel/edge',
									start: 'node1',
									end: 'node2',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())

					const shapes = records.filter((r) => r.typeName === 'shape')
					expect(shapes).toHaveLength(1)

					const shape = shapes[0] as any
					expect(shape.id).toBe('shape:node1')
					expect(shape.type).toBe('geo')
					expect(shape.props.geo).toBe('rectangle')
					expect(shape.props.color).toBe('green')
					expect(shape.props.fill).toBe('none')
				}
			})
		})

		describe('Resources structure', () => {
			it('should support representations array in resources and create assets', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'image-node',
							position: [0, 0],
							size: [200, 150],
							resource: 'resource1',
							data: [{ type: '@tldraw/node/image' }],
						},
					],
					resources: [
						{
							id: 'resource1',
							representations: [
								{
									location: 'https://example.com/image.png',
									mimeType: 'image/png',
								},
								{
									content: 'data:image/png;base64,iVBOR...',
									mimeType: 'image/png',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())

					const assets = records.filter((r) => r.typeName === 'asset')
					expect(assets).toHaveLength(1)

					const asset = assets[0] as any
					// Should use the location-based representation
					expect(asset.props.src).toBe('https://example.com/image.png')
					expect(asset.props.mimeType).toBe('image/png')

					const shapes = records.filter((r) => r.typeName === 'shape')
					expect(shapes).toHaveLength(1)

					const shape = shapes[0] as any
					expect(shape.type).toBe('image')
					expect(shape.props.assetId).toBeDefined()
				}
			})

			it('should support location, mimeType, and content in representations', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'img1',
							position: [0, 0],
							size: [100, 100],
							resource: 'resource1',
							data: [],
						},
						{
							id: 'img2',
							position: [200, 0],
							size: [100, 100],
							resource: 'resource2',
							data: [],
						},
					],
					resources: [
						{
							id: 'resource1',
							representations: [
								{
									location: 'https://example.com/image.png',
									mimeType: 'image/png',
								},
							],
						},
						{
							id: 'resource2',
							representations: [
								{
									content: 'data:image/png;base64,iVBOR...',
									mimeType: 'image/png',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const assets = records.filter((r) => r.typeName === 'asset')
					expect(assets).toHaveLength(2)

					const locationAsset = assets.find(
						(a: any) => a.props.src === 'https://example.com/image.png'
					) as any
					expect(locationAsset).toBeDefined()

					const contentAsset = assets.find(
						(a: any) => a.props.src === 'data:image/png;base64,iVBOR...'
					) as any
					expect(contentAsset).toBeDefined()
				}
			})
		})

		describe('Relations structure', () => {
			it('should support node property in relations and create bindings', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'node1',
							position: [0, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
						{
							id: 'node2',
							position: [200, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
					],
					relations: [
						{
							id: 'relation1',
							node: 'node1',
							data: [
								{
									type: '@ocif/rel/edge',
									start: 'node1',
									end: 'node2',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())

					const shapes = records.filter((r) => r.typeName === 'shape')
					expect(shapes).toHaveLength(2)

					const bindings = records.filter((r) => r.typeName === 'binding')
					expect(bindings).toHaveLength(1)

					const binding = bindings[0] as any
					expect(binding.id).toBe('binding:relation1')
					expect(binding.type).toBe('arrow')
					expect(binding.fromId).toBe('shape:node1')
					expect(binding.toId).toBe('shape:node2')
					expect(binding.props).toBeDefined()
				}
			})
		})

		describe('Schemas structure', () => {
			it('should support all schema properties: uri, schema, location, name', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [],
					schemas: [
						{
							name: '@ocif/node/rect',
							uri: 'https://spec.canvasprotocol.org/v0.6/extensions/rect-node.json',
							location: 'https://spec.canvasprotocol.org/v0.6/extensions/rect-node.json',
							schema: {
								type: 'object',
								properties: {
									type: { const: '@ocif/node/rect' },
									strokeColor: { type: 'string' },
								},
							},
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
			})
		})
	})

	describe('OCIF v0.6 Extensions', () => {
		describe('Group relations', () => {
			it('should import group relations', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'shape1',
							position: [0, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
						{
							id: 'shape2',
							position: [150, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
					],
					relations: [
						{
							id: 'group1',
							cascadeDelete: true,
							data: [
								{
									type: '@ocif/rel/group',
									members: ['shape1', 'shape2'],
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')
					const groups = shapes.filter((s: any) => s.type === 'group')

					expect(groups).toHaveLength(1)

					const childShapes = shapes.filter((s: any) => s.type !== 'group')
					expect(childShapes).toHaveLength(2)

					// Check that child shapes have the group as parent
					for (const shape of childShapes) {
						expect((shape as any).parentId).toBe(groups[0].id)
					}
				}
			})
		})

		describe('Path nodes', () => {
			it('should import path nodes as draw shapes', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'path1',
							position: [0, 0],
							size: [100, 50],
							data: [
								{
									type: '@ocif/node/path',
									strokeColor: '#FF0000',
									fillColor: 'transparent',
									strokeWidth: 4,
									path: 'M0,0 L50,25 L100,0',
									closed: false,
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const drawShape = shapes[0] as any
					expect(drawShape.type).toBe('draw')
					expect(drawShape.props.color).toBe('red')
					expect(drawShape.props.isClosed).toBe(false)
				}
			})
		})

		describe('Node Transforms Extension', () => {
			it('should import scale property from node transforms extension', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'scaled-rect',
							position: [100, 100],
							size: [100, 100],
							data: [
								{
									type: '@ocif/node/transforms',
									scale: 2.5,
									rotation: 0,
									offset: [0, 0],
								},
								{
									type: '@ocif/node/rect',
									strokeColor: '#0066CC',
									fillColor: '#0066CC',
									strokeWidth: 4,
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const shape = shapes[0] as any
					expect(shape.type).toBe('geo')
					expect(shape.props.scale).toBe(2.5)
				}
			})
		})

		describe('Text Style Extension', () => {
			it('should import text style extension for rich text', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'text1',
							position: [100, 200],
							size: [200, 50],
							data: [
								{
									type: '@ocif/node/rect',
									strokeColor: 'transparent',
									fillColor: 'transparent',
									strokeWidth: 0,
									text: 'Styled Text',
									textColor: '#FF0000',
									fontSize: 32,
									fontFamily: 'sans-serif',
									textAlign: 'center',
								},
								{
									type: '@ocif/node/textstyle',
									fontSizePx: 32,
									fontFamily: 'sans-serif',
									color: '#FF0000',
									align: 'center',
									bold: false,
									italic: false,
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const shape = shapes[0] as any
					expect(shape.type).toBe('text')
					expect(shape.props.color).toBe('red')
					expect(shape.props.font).toBe('sans')
					expect(shape.props.textAlign).toBe('middle')
				}
			})
		})

		describe('Parent-Child Relation for Frames', () => {
			it('should import frame shapes with parent-child relations', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'frame1',
							position: [0, 0],
							size: [200, 100],
							data: [
								{
									type: '@ocif/node/rect',
									strokeColor: '#0066CC',
									fillColor: 'transparent',
									strokeWidth: 2,
									isFrame: true,
									frameName: 'Test Frame',
								},
							],
						},
						{
							id: 'child1',
							position: [10, 10],
							size: [50, 50],
							data: [{ type: '@ocif/node/rect', strokeColor: '#000000', fillColor: 'transparent' }],
						},
						{
							id: 'child2',
							position: [70, 10],
							size: [50, 50],
							data: [{ type: '@ocif/node/rect', strokeColor: '#000000', fillColor: 'transparent' }],
						},
					],
					relations: [
						{
							id: 'pc1',
							data: [{ type: '@ocif/rel/parent-child', parent: 'frame1', child: 'child1' }],
						},
						{
							id: 'pc2',
							data: [{ type: '@ocif/rel/parent-child', parent: 'frame1', child: 'child2' }],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					const frames = shapes.filter((s: any) => s.type === 'frame')
					const childShapes = shapes.filter((s: any) => s.type !== 'frame')

					expect(frames).toHaveLength(1)
					expect(childShapes).toHaveLength(2)

					const frame = frames[0] as any
					expect(frame.props.name).toBe('Test Frame')
					expect(frame.props.color).toBe('blue')

					for (const shape of childShapes) {
						expect((shape as any).parentId).toBe(frame.id)
					}
				}
			})
		})

		describe('Hyperedge Relation Import', () => {
			it('should import hyperedge relations as multiple arrow bindings', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'node1',
							position: [0, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
						{
							id: 'node2',
							position: [200, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
						{
							id: 'node3',
							position: [400, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
					],
					relations: [
						{
							id: 'hyperedge1',
							data: [
								{
									type: '@ocif/rel/hyperedge',
									endpoints: [
										{ id: 'node1', direction: 'in' },
										{ id: 'node2', direction: 'in' },
										{ id: 'node3', direction: 'out' },
									],
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')
					const bindings = records.filter((r) => r.typeName === 'binding')

					expect(shapes).toHaveLength(3)
					expect(bindings.length).toBeGreaterThan(0)

					const hyperedgeBindings = bindings.filter((b: any) => b.id.includes('hyperedge'))
					expect(hyperedgeBindings.length).toBeGreaterThan(0)
				}
			})

			it('should handle undirected hyperedge endpoints', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'node1',
							position: [0, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
						{
							id: 'node2',
							position: [200, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
						{
							id: 'node3',
							position: [400, 0],
							size: [100, 100],
							data: [{ type: '@ocif/node/rect' }],
						},
					],
					relations: [
						{
							id: 'hyperedge-undir',
							data: [
								{
									type: '@ocif/rel/hyperedge',
									endpoints: [
										{ id: 'node1', direction: 'undir' },
										{ id: 'node2', direction: 'undir' },
										{ id: 'node3', direction: 'undir' },
									],
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const bindings = records.filter((r) => r.typeName === 'binding')

					const undirBindings = bindings.filter((b: any) => b.id.includes('hyperedge-undir'))
					expect(undirBindings.length).toBeGreaterThan(0)
				}
			})
		})

		describe('Note (Sticky Note) Support', () => {
			it('should import note shapes with custom tldraw extension', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'note1',
							position: [100, 200],
							size: [200, 200],
							data: [
								{
									type: '@tldraw/node/note',
									text: 'This is a sticky note',
									color: '#FFDD00',
									labelColor: '#000000',
									fontSizePx: 16,
									fontFamily: 'draw',
									align: 'middle',
									verticalAlign: 'middle',
									growY: 0,
									url: '',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const noteShape = shapes[0] as any
					expect(noteShape.type).toBe('note')
					expect(noteShape.props.color).toBe('yellow')
					expect(noteShape.props.labelColor).toBe('black')
					expect(noteShape.props.font).toBe('draw')
					expect(noteShape.props.align).toBe('middle')
					expect(noteShape.props.verticalAlign).toBe('middle')
				}
			})
		})

		describe('Embed Support', () => {
			it('should import embed shapes with custom tldraw extension', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'embed1',
							position: [50, 100],
							size: [400, 300],
							data: [
								{
									type: '@tldraw/node/embed',
									url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
									w: 400,
									h: 300,
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const embedShape = shapes[0] as any
					expect(embedShape.type).toBe('embed')
					expect(embedShape.props.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
					expect(embedShape.props.w).toBe(400)
					expect(embedShape.props.h).toBe(300)
				}
			})
		})

		describe('Bookmark Support', () => {
			it('should import bookmark shapes with asset references', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'bookmark1',
							position: [200, 150],
							size: [300, 320],
							data: [
								{
									type: '@tldraw/node/bookmark',
									assetId: 'bookmark-asset',
									url: 'https://example.com',
								},
							],
						},
					],
					resources: [
						{
							id: 'bookmark-asset',
							representations: [
								{
									location: 'https://example.com',
									mimeType: 'text/html',
								},
								{
									content: JSON.stringify({
										title: 'Example Website',
										description: 'A great example website',
										image: 'https://example.com/image.png',
										favicon: 'https://example.com/favicon.ico',
									}),
									mimeType: 'application/json',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const bookmarkShape = shapes[0] as any
					expect(bookmarkShape.type).toBe('bookmark')
					expect(bookmarkShape.props.url).toBe('https://example.com')
					expect(bookmarkShape.props.w).toBe(300)
					expect(bookmarkShape.props.h).toBe(320)
				}
			})
		})

		describe('Video Support', () => {
			it('should import video shapes with resource references', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'video1',
							position: [100, 200],
							size: [640, 480],
							resource: 'video-asset',
							data: [],
						},
					],
					resources: [
						{
							id: 'video-asset',
							representations: [
								{
									location: 'https://example.com/video.mp4',
									mimeType: 'video/mp4',
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')
					const assets = records.filter((r) => r.typeName === 'asset')

					expect(shapes).toHaveLength(1)
					expect(assets).toHaveLength(1)

					const videoShape = shapes[0] as any
					expect(videoShape.type).toBe('video')
					expect(videoShape.props.assetId).toBeDefined()
				}
			})
		})

		describe('Highlight Support', () => {
			it('should import highlight shapes with custom tldraw extension', () => {
				const testOcif = JSON.stringify({
					ocif: 'https://canvasprotocol.org/ocif/v0.6',
					nodes: [
						{
							id: 'highlight1',
							position: [0, 0],
							size: [200, 10],
							data: [
								{
									type: '@tldraw/node/highlight',
									path: 'M0,0 L100,10 L200,0',
									color: '#FFDD00',
									size: 8,
									isComplete: true,
								},
							],
						},
					],
				})

				const parseResult = parseOcifFile({ json: testOcif, schema })
				expect(parseResult.ok).toBe(true)
				if (parseResult.ok) {
					const records = Array.from(parseResult.value.allRecords())
					const shapes = records.filter((r) => r.typeName === 'shape')

					expect(shapes).toHaveLength(1)
					const highlightShape = shapes[0] as any
					expect(highlightShape.type).toBe('highlight')
					expect(highlightShape.props.color).toBe('yellow')
					expect(highlightShape.props.isComplete).toBe(true)
				}
			})
		})
	})

	describe('Basic shapes import', () => {
		it('should import a rectangle', () => {
			const testOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [
					{
						id: 'rect1',
						position: [100, 100],
						size: [200, 150],
						data: [
							{
								type: '@ocif/node/rect',
								strokeColor: '#0066CC',
								fillColor: '#0066CC',
								strokeWidth: 4,
							},
						],
					},
				],
			})

			const parseResult = parseOcifFile({ json: testOcif, schema })
			expect(parseResult.ok).toBe(true)
			if (parseResult.ok) {
				const shapes = Array.from(parseResult.value.allRecords()).filter(
					(r) => r.typeName === 'shape'
				)
				expect(shapes).toHaveLength(1)
				const shape = shapes[0] as any
				expect(shape.type).toBe('geo')
				expect(shape.props.geo).toBe('rectangle')
				expect(shape.props.color).toBe('blue')
				expect(shape.props.fill).toBe('solid')
			}
		})

		it('should import an ellipse', () => {
			const testOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [
					{
						id: 'ellipse1',
						position: [50, 75],
						size: [100, 80],
						data: [
							{
								type: '@ocif/node/oval',
								strokeColor: '#FF0000',
								fillColor: 'transparent',
								strokeWidth: 2,
							},
						],
					},
				],
			})

			const parseResult = parseOcifFile({ json: testOcif, schema })
			expect(parseResult.ok).toBe(true)
			if (parseResult.ok) {
				const shapes = Array.from(parseResult.value.allRecords()).filter(
					(r) => r.typeName === 'shape'
				)
				expect(shapes).toHaveLength(1)
				const shape = shapes[0] as any
				expect(shape.type).toBe('geo')
				expect(shape.props.geo).toBe('ellipse')
				expect(shape.props.color).toBe('red')
				expect(shape.props.fill).toBe('none')
			}
		})

		it('should import an arrow', () => {
			const testOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [
					{
						id: 'arrow1',
						position: [0, 0],
						size: [100, 50],
						data: [
							{
								type: '@ocif/node/arrow',
								strokeColor: '#00AA00',
								start: [10, 10],
								end: [100, 50],
								startMarker: 'none',
								endMarker: 'arrowhead',
								strokeWidth: 8,
							},
						],
					},
				],
			})

			const parseResult = parseOcifFile({ json: testOcif, schema })
			expect(parseResult.ok).toBe(true)
			if (parseResult.ok) {
				const shapes = Array.from(parseResult.value.allRecords()).filter(
					(r) => r.typeName === 'shape'
				)
				expect(shapes).toHaveLength(1)
				const shape = shapes[0] as any
				expect(shape.type).toBe('arrow')
				expect(shape.props.color).toBe('green')
				expect(shape.props.arrowheadStart).toBe('none')
				expect(shape.props.arrowheadEnd).toBe('arrow')
			}
		})
	})

	describe('Complex scenarios', () => {
		it('should handle multiple shapes', () => {
			const testOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [
					{
						id: 'rect1',
						position: [0, 0],
						size: [100, 100],
						data: [{ type: '@ocif/node/rect', strokeColor: '#0066CC' }],
					},
					{
						id: 'ellipse1',
						position: [150, 0],
						size: [100, 100],
						data: [{ type: '@ocif/node/oval', strokeColor: '#FF0000' }],
					},
					{
						id: 'arrow1',
						position: [0, 0],
						size: [100, 50],
						data: [
							{
								type: '@ocif/node/arrow',
								strokeColor: '#00AA00',
								start: [50, 50],
								end: [200, 50],
								startMarker: 'none',
								endMarker: 'arrowhead',
								strokeWidth: 4,
							},
						],
					},
				],
			})

			const parseResult = parseOcifFile({ json: testOcif, schema })
			expect(parseResult.ok).toBe(true)
			if (parseResult.ok) {
				const shapes = Array.from(parseResult.value.allRecords()).filter(
					(r) => r.typeName === 'shape'
				)
				expect(shapes).toHaveLength(3)
			}
		})

		it('should handle empty canvas', () => {
			const testOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [],
			})

			const parseResult = parseOcifFile({ json: testOcif, schema })
			expect(parseResult.ok).toBe(true)
		})
	})

	describe('Error handling', () => {
		it('should handle invalid JSON', () => {
			const parseResult = parseOcifFile({
				json: 'invalid json',
				schema,
			})

			expect(parseResult.ok).toBe(false)
			if (!parseResult.ok) {
				expect(parseResult.error.type).toBe('notAnOcifFile')
			}
		})

		it('should handle missing OCIF version', () => {
			const invalidOcif = JSON.stringify({
				nodes: [],
			})

			const parseResult = parseOcifFile({
				json: invalidOcif,
				schema,
			})

			expect(parseResult.ok).toBe(false)
			if (!parseResult.ok) {
				expect(parseResult.error.type).toBe('notAnOcifFile')
			}
		})

		it('should handle unsupported OCIF version', () => {
			const unsupportedOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v1.0',
				nodes: [],
			})

			const parseResult = parseOcifFile({
				json: unsupportedOcif,
				schema,
			})

			expect(parseResult.ok).toBe(false)
			if (!parseResult.ok) {
				expect(parseResult.error.type).toBe('ocifVersionNotSupported')
			}
		})

		it('should handle unknown shape types gracefully', () => {
			const unknownShapeOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [
					{
						id: 'shape:unknown',
						position: [0, 0],
						size: [100, 100],
						data: [
							{
								type: '@unknown/node/type',
								someProperty: 'value',
							},
						],
					},
				],
			})

			const parseResult = parseOcifFile({
				json: unknownShapeOcif,
				schema,
			})

			expect(parseResult.ok).toBe(true)
			if (parseResult.ok) {
				const shapes = Array.from(parseResult.value.allRecords()).filter(
					(r) => r.typeName === 'shape'
				)
				expect(shapes).toHaveLength(1)
				const shape = shapes[0] as any
				expect(shape.type).toBe('geo')
				expect(shape.props.geo).toBe('rectangle')
			}
		})
	})

	describe('Representations fallback', () => {
		it('should extract altText from plain text representations', () => {
			const testOcif = JSON.stringify({
				ocif: 'https://canvasprotocol.org/ocif/v0.6',
				nodes: [
					{
						id: 'image-node',
						position: [0, 0],
						size: [200, 150],
						resource: 'resource1',
						data: [
							{ type: '@ocif/node/rect', strokeColor: 'transparent', fillColor: 'transparent' },
						],
					},
				],
				resources: [
					{
						id: 'resource1',
						representations: [
							{
								location: 'https://example.com/image.png',
								mimeType: 'image/png',
							},
							{
								content: 'A beautiful landscape with mountains and trees',
								mimeType: 'text/plain',
							},
						],
					},
				],
			})

			const parseResult = parseOcifFile({ json: testOcif, schema })
			expect(parseResult.ok).toBe(true)
			if (parseResult.ok) {
				const records = Array.from(parseResult.value.allRecords())
				const shapes = records.filter((r) => r.typeName === 'shape')

				expect(shapes).toHaveLength(1)
				const imageShape = shapes[0] as any
				expect(imageShape.type).toBe('image')
				expect(imageShape.props.altText).toBe('A beautiful landscape with mountains and trees')
			}
		})
	})
})

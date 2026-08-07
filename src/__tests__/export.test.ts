import { b64Vecs } from '@tldraw/tlschema'
import { createTLSchema } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { parseOcifFile, serializeTldrawRecordsToOcif, type OcifFile } from '../ocif'

const schema = createTLSchema()

/** Import an OCIF file and return the resulting records. */
function importRecords(ocif: object) {
	const result = parseOcifFile({ json: JSON.stringify(ocif), schema })
	if (!result.ok) throw new Error(`parse failed: ${JSON.stringify(result.error)}`)
	return Array.from(result.value.allRecords())
}

/** Import an OCIF file, then export the records back to an OCIF file. */
async function roundTrip(ocif: object): Promise<OcifFile> {
	const json = await serializeTldrawRecordsToOcif(importRecords(ocif))
	return JSON.parse(json)
}

describe('Export (tldraw → OCIF)', () => {
	describe('Geo shape round-trip', () => {
		it('should preserve position, size, and colors', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'rect1',
						position: [100, 200],
						size: [300, 150],
						data: [
							{
								type: '@ocif/rect',
								strokeColor: '#0066CC',
								fillColor: '#0066CC',
								strokeWidth: 4,
							},
						],
					},
				],
			})

			expect(out.nodes).toHaveLength(1)
			const node = out.nodes![0]
			expect(node.id).toBe('shape:rect1')
			expect(node.position).toEqual([100, 200])
			expect(node.size).toEqual([300, 150])
			const rect = node.data!.find((d) => d.type === '@ocif/rect')!
			expect(rect.strokeColor).toBe('#0066CC')
			expect(rect.fillColor).toBe('#0066CC')
		})

		it('should preserve geoType for non-rectangle geo shapes', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'star1',
						position: [0, 0],
						size: [100, 100],
						data: [
							{
								type: '@ocif/rect',
								strokeColor: '#FF0000',
								fillColor: 'transparent',
								strokeWidth: 2,
								geoType: 'star',
							},
						],
					},
				],
			})

			const rect = out.nodes![0].data!.find((d) => d.type === '@ocif/rect')!
			expect(rect.geoType).toBe('star')
		})

		it('should round-trip flipX/flipY', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'flipped',
						position: [0, 0],
						size: [100, 100],
						data: [
							{
								type: '@ocif/rect',
								strokeColor: '#000000',
								fillColor: 'transparent',
								strokeWidth: 2,
								flipX: true,
							},
						],
					},
				],
			})

			const rect = out.nodes![0].data!.find((d) => d.type === '@ocif/rect')!
			expect(rect.flipX).toBe(true)
			expect(rect.flipY).toBeUndefined()
		})
	})

	describe('Draw shape segment codec', () => {
		it('should decode imported SVG paths into real segment points', () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'path1',
						position: [0, 0],
						size: [100, 25],
						data: [
							{
								type: '@ocif/path',
								strokeColor: '#FF0000',
								fillColor: 'transparent',
								strokeWidth: 4,
								path: 'M0,0 L50,25 L100,0',
							},
						],
					},
				],
			})

			const draw = records.find((r: any) => r.typeName === 'shape' && r.type === 'draw') as any
			expect(draw).toBeDefined()
			expect(draw.props.segments).toHaveLength(1)

			// The segment path must be valid delta-encoded base64, not SVG text
			const points = b64Vecs.decodePoints(draw.props.segments[0].path)
			expect(points.map((p: any) => [p.x, p.y])).toEqual([
				[0, 0],
				[50, 25],
				[100, 0],
			])
		})

		it('should round-trip a draw shape back to the same SVG path', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'path1',
						position: [10, 20],
						size: [100, 25],
						data: [
							{
								type: '@ocif/path',
								strokeColor: '#FF0000',
								fillColor: 'transparent',
								strokeWidth: 4,
								path: 'M0,0 L50,25 L100,0',
							},
						],
					},
				],
			})

			const pathData = out.nodes![0].data!.find((d) => d.type === '@ocif/path')!
			expect(pathData.path).toBe('M0,0L50,25L100,0')
			// Size derives from the actual stroke bounds, not a 100×100 fallback
			expect(out.nodes![0].size).toEqual([100, 25])
		})

		it('should split multiple subpaths into separate segments', () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'multi',
						position: [0, 0],
						size: [100, 100],
						data: [
							{
								type: '@ocif/path',
								strokeColor: '#000000',
								fillColor: 'transparent',
								strokeWidth: 2,
								path: 'M0,0 L10,10 M20,20 L30,30',
							},
						],
					},
				],
			})

			const draw = records.find((r: any) => r.typeName === 'shape' && r.type === 'draw') as any
			expect(draw.props.segments).toHaveLength(2)
		})
	})

	describe('Arrow edge export', () => {
		it('should export one @ocif/edge per arrow with start/end from terminals', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'node1',
						position: [0, 0],
						size: [50, 50],
						data: [{ type: '@ocif/rect', strokeColor: '#000000' }],
					},
					{
						id: 'node2',
						position: [200, 0],
						size: [50, 50],
						data: [{ type: '@ocif/rect', strokeColor: '#000000' }],
					},
					{
						id: 'arrow1',
						position: [50, 25],
						size: [150, 1],
						data: [
							{
								type: '@ocif/arrow',
								strokeColor: '#000000',
								start: [0, 0],
								end: [150, 0],
								startMarker: 'none',
								endMarker: 'arrowhead',
								strokeWidth: 2,
							},
							{ type: '@ocif/edge', start: 'node1', end: 'node2' },
						],
					},
				],
			})

			const arrowNode = out.nodes!.find((n) => n.id === 'shape:arrow1')!
			const edges = arrowNode.data!.filter((d) => d.type === '@ocif/edge')
			expect(edges).toHaveLength(1)
			expect(edges[0].start).toBe('shape:node1')
			expect(edges[0].end).toBe('shape:node2')
		})
	})

	describe('Group round-trip', () => {
		it('should keep member positions stable across import/export cycles', async () => {
			const source = {
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'a',
						position: [100, 100],
						size: [50, 50],
						data: [{ type: '@ocif/rect', strokeColor: '#000000' }],
					},
					{
						id: 'b',
						position: [200, 100],
						size: [50, 50],
						data: [{ type: '@ocif/rect', strokeColor: '#000000' }],
					},
					{
						id: 'g',
						position: [100, 100],
						data: [{ type: '@ocif/group', members: ['a', 'b'], cascadeDelete: true }],
					},
				],
			}

			// Two full cycles: any absolute/relative confusion would shift
			// positions further on each pass.
			const once = await roundTrip(source)
			const twice = await roundTrip(once as object)

			for (const out of [once, twice]) {
				const a = out.nodes!.find((n) => n.id === 'shape:a')!
				const b = out.nodes!.find((n) => n.id === 'shape:b')!
				expect(a.position).toEqual([100, 100])
				expect(b.position).toEqual([200, 100])

				const group = out.nodes!.find((n) =>
					(n.data ?? []).some((d) => d.type === '@ocif/group')
				)!
				expect(group.position).toEqual([100, 100])
			}
		})
	})

	describe('Frame round-trip', () => {
		it('should keep frame children relative and preserve empty frames', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'frame1',
						position: [500, 500],
						size: [200, 100],
						data: [
							{
								type: '@ocif/rect',
								strokeColor: '#0066CC',
								fillColor: 'transparent',
								strokeWidth: 2,
								isFrame: true,
								frameName: 'My Frame',
							},
						],
					},
					{
						id: 'child1',
						position: [10, 10],
						size: [50, 50],
						parent: 'frame1',
						data: [{ type: '@ocif/rect', strokeColor: '#000000' }],
					},
					{
						id: 'empty-frame',
						position: [0, 900],
						size: [150, 150],
						data: [
							{
								type: '@ocif/rect',
								strokeColor: '#000000',
								fillColor: 'transparent',
								strokeWidth: 2,
								isFrame: true,
								frameName: 'Empty',
							},
						],
					},
				],
			})

			const frame = out.nodes!.find((n) => n.id === 'shape:frame1')!
			expect(frame.data!.find((d) => d.isFrame)?.frameName).toBe('My Frame')
			expect(frame.position).toEqual([500, 500])

			const child = out.nodes!.find((n) => n.id === 'shape:child1')!
			expect(child.parent).toBe('shape:frame1')
			expect(child.position).toEqual([10, 10])

			// An empty frame must survive the round trip
			const emptyFrame = out.nodes!.find((n) => n.id === 'shape:empty-frame')!
			expect(emptyFrame).toBeDefined()
			expect(emptyFrame.data!.find((d) => d.isFrame)?.frameName).toBe('Empty')
		})
	})

	describe('Note round-trip', () => {
		it('should preserve the note font size', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'note1',
						position: [0, 0],
						size: [200, 200],
						data: [
							{
								type: '@tldraw/node/note',
								text: 'hello',
								color: '#FFDD00',
								labelColor: '#000000',
								fontSizePx: 32,
								fontFamily: 'sans-serif',
								align: 'middle',
								verticalAlign: 'middle',
								growY: 0,
								url: '',
							},
						],
					},
				],
			})

			const note = out.nodes![0].data!.find((d) => d.type === '@tldraw/node/note')!
			// 32px → size 'l' → 8 * 4 = 32px
			expect(note.fontSizePx).toBe(32)
			expect(note.text).toBe('hello')
		})
	})

	describe('Z-order', () => {
		it('should assign unique ascending indexes on import and export nodes in z-order', async () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{ id: 'r1', position: [0, 0], size: [10, 10], data: [{ type: '@ocif/rect' }] },
					{ id: 'r2', position: [5, 5], size: [10, 10], data: [{ type: '@ocif/rect' }] },
					{ id: 'r3', position: [10, 10], size: [10, 10], data: [{ type: '@ocif/rect' }] },
				],
			})

			const shapes = records.filter((r: any) => r.typeName === 'shape') as any[]
			const indexes = shapes.map((s) => s.index)
			expect(new Set(indexes).size).toBe(3)

			// Node order is preserved as z-order (ascending indexes)
			const byId = Object.fromEntries(shapes.map((s) => [s.id, s.index]))
			expect(byId['shape:r1'] < byId['shape:r2']).toBe(true)
			expect(byId['shape:r2'] < byId['shape:r3']).toBe(true)

			// Export lists nodes back in the same z-order
			const out: OcifFile = JSON.parse(await serializeTldrawRecordsToOcif(records))
			expect(out.nodes!.map((n) => n.id)).toEqual(['shape:r1', 'shape:r2', 'shape:r3'])
		})
	})

	describe('Multi-page documents', () => {
		it('should only export shapes on the requested page', async () => {
			const baseShape = (id: string, parentId: string, index: string) => ({
				id,
				typeName: 'shape',
				type: 'geo',
				x: 0,
				y: 0,
				rotation: 0,
				index,
				parentId,
				isLocked: false,
				opacity: 1,
				meta: {},
				props: { geo: 'rectangle', w: 100, h: 100, color: 'black', fill: 'none', size: 'm' },
			})
			const records = [
				{ id: 'page:one', typeName: 'page', name: 'One', index: 'a1', meta: {} },
				{ id: 'page:two', typeName: 'page', name: 'Two', index: 'a2', meta: {} },
				baseShape('shape:on-one', 'page:one', 'a1'),
				baseShape('shape:on-two', 'page:two', 'a1'),
			] as any[]

			const outOne: OcifFile = JSON.parse(
				await serializeTldrawRecordsToOcif(records, { pageId: 'page:one' })
			)
			expect(outOne.nodes!.map((n) => n.id)).toEqual(['shape:on-one'])

			// Defaults to the first page when none is given
			const outDefault: OcifFile = JSON.parse(await serializeTldrawRecordsToOcif(records))
			expect(outDefault.nodes!.map((n) => n.id)).toEqual(['shape:on-one'])
		})
	})

	describe('Text styles', () => {
		it('should round-trip text nodes and report bold/italic marks', async () => {
			const out = await roundTrip({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'text1',
						position: [0, 0],
						size: [200, 50],
						data: [
							{
								type: '@ocif/rect',
								strokeColor: 'transparent',
								fillColor: 'transparent',
								strokeWidth: 0,
								text: 'Hello',
								textColor: '#FF0000',
								fontSize: 32,
							},
							{
								type: '@ocif/textstyle',
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

			const node = out.nodes!.find((n) => n.id === 'shape:text1')!
			const rect = node.data!.find((d) => d.type === '@ocif/rect')!
			expect(rect.text).toBe('Hello')
			expect(rect.strokeColor).toBe('transparent')

			const style = node.data!.find((d) => d.type === '@ocif/textstyle')!
			expect(style.fontSizePx).toBe(32)
			expect(style.fontFamily).toBe('sans-serif')
			expect(style.bold).toBe(false)
			expect(style.italic).toBe(false)
		})
	})

	describe('Color handling', () => {
		it('should map lowercase and off-palette hex colors to the nearest tldraw color', () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'lower',
						position: [0, 0],
						size: [10, 10],
						data: [{ type: '@ocif/rect', strokeColor: '#ff0000', fillColor: 'transparent' }],
					},
					{
						id: 'nearby',
						position: [20, 0],
						size: [10, 10],
						data: [{ type: '@ocif/rect', strokeColor: '#fe0102', fillColor: 'transparent' }],
					},
				],
			})

			const shapes = records.filter((r: any) => r.typeName === 'shape') as any[]
			expect(shapes.find((s) => s.id === 'shape:lower').props.color).toBe('red')
			expect(shapes.find((s) => s.id === 'shape:nearby').props.color).toBe('red')
		})

		it('should not treat opaque colors ending in 80 as semi-transparent fills', () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'navy',
						position: [0, 0],
						size: [10, 10],
						data: [{ type: '@ocif/rect', strokeColor: '#000000', fillColor: '#000080' }],
					},
					{
						id: 'semi',
						position: [20, 0],
						size: [10, 10],
						data: [{ type: '@ocif/rect', strokeColor: '#000000', fillColor: '#FF000080' }],
					},
				],
			})

			const shapes = records.filter((r: any) => r.typeName === 'shape') as any[]
			expect(shapes.find((s) => s.id === 'shape:navy').props.fill).toBe('solid')
			expect(shapes.find((s) => s.id === 'shape:semi').props.fill).toBe('semi')
		})
	})

	describe('Robustness', () => {
		it('should accept nodes without a data array', () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{ id: 'bare', position: [0, 0], size: [100, 100] },
					{
						id: 'rect1',
						position: [200, 0],
						size: [100, 100],
						data: [{ type: '@ocif/rect', strokeColor: '#000000' }],
					},
				],
			})

			// The bare node is skipped, but the rest of the file still imports
			const shapes = records.filter((r: any) => r.typeName === 'shape')
			expect(shapes).toHaveLength(1)
		})

		it('should reject v0.71 while accepting v0.7 and v0.7.0', () => {
			const make = (version: string) =>
				parseOcifFile({
					json: JSON.stringify({ ocif: `https://canvasprotocol.org/ocif/${version}`, nodes: [] }),
					schema,
				})

			expect(make('v0.7').ok).toBe(true)
			expect(make('v0.7.0').ok).toBe(true)
			expect(make('v0.71').ok).toBe(false)
			expect(make('v0.6').ok).toBe(false)
		})

		it('should not double-prefix asset IDs', () => {
			const records = importRecords({
				ocif: 'https://canvasprotocol.org/ocif/v0.7.0',
				nodes: [
					{
						id: 'img1',
						position: [0, 0],
						size: [100, 100],
						resource: 'asset:abc123',
						data: [],
					},
				],
				resources: [
					{
						id: 'asset:abc123',
						representations: [
							{ content: 'data:image/png;base64,iVBOR...', mimeType: 'image/png' },
						],
					},
				],
			})

			const asset = records.find((r: any) => r.typeName === 'asset') as any
			expect(asset.id).toBe('asset:abc123')
		})
	})
})

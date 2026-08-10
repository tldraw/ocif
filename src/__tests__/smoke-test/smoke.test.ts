import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTLSchema, parseTldrawJsonFile } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { parseOcifFile } from '../../ocif'

const schema = createTLSchema()

const fixtureDir = dirname(fileURLToPath(import.meta.url))
const ocifJson = readFileSync(resolve(fixtureDir, 'QA pruned.ocif.json'), 'utf8')
const tldrJson = readFileSync(resolve(fixtureDir, 'QA pruned.tldr'), 'utf8')

describe('Smoke test — QA pruned fixture', () => {
	// -----------------------------------------------------------------------
	// .tldr fixture validity
	// -----------------------------------------------------------------------

	describe('.tldr fixture', () => {
		it('should parse the .tldr file as a valid tldraw document', () => {
			const result = parseTldrawJsonFile({ json: tldrJson, schema })
			expect(result.ok).toBe(true)
		})

		it('should contain the expected record types', () => {
			const result = parseTldrawJsonFile({ json: tldrJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape')
			const bindings = records.filter((r) => r.typeName === 'binding')
			const assets = records.filter((r) => r.typeName === 'asset')

			expect(shapes.length).toBeGreaterThan(0)
			expect(bindings.length).toBeGreaterThan(0)
			expect(assets.length).toBeGreaterThan(0)
		})
	})

	// -----------------------------------------------------------------------
	// OCIF → tldraw conversion output
	// -----------------------------------------------------------------------

	describe('OCIF → tldraw conversion', () => {
		it('should parse the .ocif.json fixture without errors', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			expect(result.ok).toBe(true)
		})

		it('should produce the expected number of shapes', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape')
			// 13 nodes in the fixture → 13 shapes
			expect(shapes).toHaveLength(13)
		})

		it('should produce the expected shape types', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			const typeCounts: Record<string, number> = {}
			for (const s of shapes) {
				typeCounts[s.type] = (typeCounts[s.type] || 0) + 1
			}

			expect(typeCounts).toEqual({
				embed: 1,
				geo: 2,
				draw: 2,
				image: 2,
				note: 1,
				frame: 1,
				text: 2,
				arrow: 1,
				bookmark: 1,
			})
		})

		it('should create bindings for edge extensions', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const bindings = records.filter((r) => r.typeName === 'binding')

			// 2 edge extensions on the arrow node in the v0.7.0 fixture
			expect(bindings.length).toBeGreaterThanOrEqual(2)
		})

		it('should create assets for resources', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const assets = records.filter((r) => r.typeName === 'asset') as any[]

			// 2 resources in the fixture → 2 assets
			expect(assets).toHaveLength(2)

			// Bookmark asset
			const bookmarkAsset = assets.find((a) => a.type === 'bookmark')
			expect(bookmarkAsset).toBeDefined()
			expect(bookmarkAsset.props.title).toBe('Arrow (symbol) - Wikipedia')

			// Image asset
			const imageAsset = assets.find((a) => a.type === 'image')
			expect(imageAsset).toBeDefined()
			expect(imageAsset.props.mimeType).toBe('image/gif')
		})

		it('should set up frame parent-child relationships', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			// The frame
			const frame = shapes.find((s) => s.id === 'shape:EafuN84Co6qt8HA1O0TKK')
			expect(frame).toBeDefined()
			expect(frame.type).toBe('frame')

			// Children should have the frame as parentId
			const child1 = shapes.find((s) => s.id === 'shape:kRMIxYWZibzona6uNr_sF')
			const child2 = shapes.find((s) => s.id === 'shape:VaPY7E7hh1CL-UbII-11F')
			expect(child1).toBeDefined()
			expect(child2).toBeDefined()
			expect(child1.parentId).toBe(frame.id)
			expect(child2.parentId).toBe(frame.id)
		})

		it('should correctly position shapes', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			// Spot check a few shapes
			const embed = shapes.find((s) => s.id === 'shape:SKQ4o_JpBhbd6CopU7i3-')
			expect(embed).toBeDefined()
			expect(embed.x).toBeCloseTo(758.37, 1)
			expect(embed.y).toBeCloseTo(947.88, 1)

			const rect = shapes.find((s) => s.id === 'shape:G90KOkkci7b-x0OP2h_jo')
			expect(rect).toBeDefined()
			expect(rect.x).toBeCloseTo(-5.0, 0)
			expect(rect.y).toBeCloseTo(293.69, 1)
		})

		it('should correctly size shapes', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			const embed = shapes.find((s) => s.id === 'shape:SKQ4o_JpBhbd6CopU7i3-')
			expect(embed.props.w).toBeCloseTo(414.05, 1)
			expect(embed.props.h).toBeCloseTo(232.90, 1)

			const rect = shapes.find((s) => s.id === 'shape:G90KOkkci7b-x0OP2h_jo')
			expect(rect.props.w).toBeCloseTo(92.95, 1)
			expect(rect.props.h).toBeCloseTo(83.40, 1)
		})

		it('should handle embed nodes', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			const embed = shapes.find((s) => s.id === 'shape:SKQ4o_JpBhbd6CopU7i3-')
			expect(embed.type).toBe('embed')
			expect(embed.props.url).toBe('https://www.youtube.com/watch?v=OKcsrdr00-A')
		})

		it('should handle note nodes', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			const note = shapes.find((s) => s.id === 'shape:YL8sYE7y5R8c3gKQ04i41')
			expect(note).toBeDefined()
			expect(note.type).toBe('note')
		})

		it('should handle bookmark nodes', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const shapes = records.filter((r) => r.typeName === 'shape') as any[]

			const bookmark = shapes.find((s) => s.id === 'shape:8qnyJ2QrM_p9qORBMTzdV')
			expect(bookmark).toBeDefined()
			expect(bookmark.type).toBe('bookmark')
			expect(bookmark.props.url).toBe('https://en.wikipedia.org/wiki/Arrow_(symbol)')
		})

		it('should wire up arrow bindings correctly', () => {
			const result = parseOcifFile({ json: ocifJson, schema })
			if (!result.ok) throw new Error('Parse failed')

			const records = Array.from(result.value.allRecords())
			const bindings = records.filter((r) => r.typeName === 'binding') as any[]

			expect(bindings).toHaveLength(2)

			// Both bindings originate from the arrow node
			for (const b of bindings) {
				expect(b.type).toBe('arrow')
				expect(b.fromId).toBe('shape:sEDTvhfZGpq0WGVPlPWh8')
			}

			// One should connect to each target
			const toIds = bindings.map((b: any) => b.toId).sort()
			expect(toIds).toEqual([
				'shape:G90KOkkci7b-x0OP2h_jo',
				'shape:nq8CfmDFcx27dd171PIYS',
			])
		})
	})

	// -----------------------------------------------------------------------
	// Cross-check: OCIF output should match the .tldr source
	// -----------------------------------------------------------------------

	describe('.tldr ↔ .ocif.json cross-check', () => {
		it('should produce the same shape IDs from OCIF as exist in the .tldr', () => {
			const ocifResult = parseOcifFile({ json: ocifJson, schema })
			const tldrResult = parseTldrawJsonFile({ json: tldrJson, schema })
			if (!ocifResult.ok) throw new Error('OCIF parse failed')
			if (!tldrResult.ok) throw new Error('tldr parse failed')

			const tldrShapes = Array.from(tldrResult.value.allRecords())
				.filter((r) => r.typeName === 'shape')
				.map((r) => r.id)
				.sort()

			const ocifShapes = Array.from(ocifResult.value.allRecords())
				.filter((r) => r.typeName === 'shape')
				.map((r) => r.id)
				.sort()

			expect(ocifShapes).toEqual(tldrShapes)
		})

		it('should produce the same number of bindings from OCIF as exist in the .tldr', () => {
			const ocifResult = parseOcifFile({ json: ocifJson, schema })
			const tldrResult = parseTldrawJsonFile({ json: tldrJson, schema })
			if (!ocifResult.ok) throw new Error('OCIF parse failed')
			if (!tldrResult.ok) throw new Error('tldr parse failed')

			const tldrBindings = Array.from(tldrResult.value.allRecords())
				.filter((r) => r.typeName === 'binding')

			const ocifBindings = Array.from(ocifResult.value.allRecords())
				.filter((r) => r.typeName === 'binding')

			expect(ocifBindings).toHaveLength(tldrBindings.length)
		})

		it('should produce the same number of assets from OCIF as exist in the .tldr', () => {
			const ocifResult = parseOcifFile({ json: ocifJson, schema })
			const tldrResult = parseTldrawJsonFile({ json: tldrJson, schema })
			if (!ocifResult.ok) throw new Error('OCIF parse failed')
			if (!tldrResult.ok) throw new Error('tldr parse failed')

			const tldrAssets = Array.from(tldrResult.value.allRecords())
				.filter((r) => r.typeName === 'asset')

			const ocifAssets = Array.from(ocifResult.value.allRecords())
				.filter((r) => r.typeName === 'asset')

			expect(ocifAssets).toHaveLength(tldrAssets.length)

			// Asset record IDs round-trip exactly (no double "asset:" prefix)
			const tldrIds = tldrAssets.map((a) => a.id).sort()
			const ocifIds = ocifAssets.map((a) => a.id).sort()
			expect(ocifIds).toEqual(tldrIds)
		})

		it('should produce matching shape types from OCIF and .tldr', () => {
			const ocifResult = parseOcifFile({ json: ocifJson, schema })
			const tldrResult = parseTldrawJsonFile({ json: tldrJson, schema })
			if (!ocifResult.ok) throw new Error('OCIF parse failed')
			if (!tldrResult.ok) throw new Error('tldr parse failed')

			const tldrShapes = Array.from(tldrResult.value.allRecords())
				.filter((r) => r.typeName === 'shape') as any[]
			const ocifShapes = Array.from(ocifResult.value.allRecords())
				.filter((r) => r.typeName === 'shape') as any[]

			for (const tldrShape of tldrShapes) {
				const ocifShape = ocifShapes.find((s) => s.id === tldrShape.id)
				expect(ocifShape, `shape ${tldrShape.id} missing from OCIF output`).toBeDefined()
				expect(ocifShape.type, `shape ${tldrShape.id} type mismatch`).toBe(tldrShape.type)
			}
		})
	})
})

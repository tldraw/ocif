import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['tldraw', '@tldraw/tlschema', '@tldraw/utils'],
	treeshake: true,
})

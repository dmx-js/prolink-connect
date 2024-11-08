import {kaitaiLoader} from 'esbuild-plugin-kaitai/dist/index.js';
import KaitaiStructCompiler from 'kaitai-struct-compiler';
import {defineConfig} from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	dts: true,
	format: ['esm'],
	target: 'esnext',
	platform: 'neutral',
	skipNodeModulesBundle: true,
	banner: {
		js: `
			import {createRequire} from 'module';
			const require = createRequire(import.meta.url);
		`,
	},
	esbuildPlugins: [
		kaitaiLoader({
			compiler: new KaitaiStructCompiler(),
		}),
	],
});

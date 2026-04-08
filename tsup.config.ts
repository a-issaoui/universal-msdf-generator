import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/converter-worker.ts'],
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      ignoreDeprecations: '6.0',
    },
  },
  clean: true,
  sourcemap: true,
  minify: false,
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
  splitting: true,
});

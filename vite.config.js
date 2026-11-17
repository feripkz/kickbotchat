import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const piperAssets = {
  name: 'copy-piper-assets',
  apply: 'build',
  closeBundle() {
    const source = resolve('node_modules/piper-tts-web/dist');
    const destination = resolve('dist');
    const files = [
      ['onnx/ort-wasm-simd-threaded.wasm', 'onnx/ort-wasm-simd-threaded.wasm'],
      ['piper/piper_phonemize.data', 'piper/piper_phonemize.data'],
      ['piper/piper_phonemize.wasm', 'piper/piper_phonemize.wasm'],
      ['worker/ExpressionWebWorker.js', 'worker/ExpressionWebWorker.js'],
      ['worker/OnnxWebWorker.js', 'worker/OnnxWebWorker.js'],
      ['worker/PhonemizeWebWorker.js', 'worker/PhonemizeWebWorker.js'],
    ];
    for (const [from, to] of files) {
      mkdirSync(resolve(destination, to, '..'), { recursive: true });
      copyFileSync(resolve(source, from), resolve(destination, to));
    }
  },
};

export default defineConfig({ plugins: [react(), piperAssets] });

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative base so the same build works inside a Capacitor iOS bundle.
  base: './',
  build: { outDir: 'dist' },
  server: { host: true },
});

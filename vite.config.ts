import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { acpModelPreview } from './scripts/dev/acpModels.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), acpModelPreview()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  server: {
    port: 1420,
    strictPort: true,
  },
})

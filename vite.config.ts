import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { acpModelPreview } from './scripts/dev/acpModels.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), acpModelPreview()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
})

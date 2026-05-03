import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Allow VITE_BASE_PATH overrides so the Electron desktop build can use a
  // relative base ('./'), which is required when assets are loaded over file://.
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __BUILD_NUMBER__: JSON.stringify(
      `d-${new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '')}`
    ),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@oasis/ui-kit": path.resolve(__dirname, "../../packages/ui-kit/src"),
    },
  },
})

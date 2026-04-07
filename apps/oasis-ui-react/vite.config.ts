import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
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

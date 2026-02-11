import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/fred': {
        target: 'https://api.stlouisfed.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fred/, '/fred/series/observations'),
      },
      '/api/fiscal': {
        target: 'https://api.fiscaldata.treasury.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/fiscal/, ''),
      },
      '/api/tic': {
        target: 'https://ticdata.treasury.gov',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tic/, ''),
      },
    },
  },
})

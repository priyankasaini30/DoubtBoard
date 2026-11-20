import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the client talks to the API through this proxy, so there is no CORS to set up.
// In production set VITE_API_URL to the deployed API origin instead.
const API = process.env.VITE_DEV_API ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/socket.io': { target: API, ws: true,
        configure: (proxy) => {
          proxy.on('error', () => {});
          proxy.on('proxyReq', (_req,_res,socket) =>  socket.on('error', () => {}));
          }
        },
      },
  },
});

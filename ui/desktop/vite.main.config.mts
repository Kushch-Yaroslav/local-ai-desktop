import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    'process.env.GITHUB_OWNER': JSON.stringify(process.env.GITHUB_OWNER || 'Kushch-Yaroslav'),
    'process.env.GITHUB_REPO': JSON.stringify(process.env.GITHUB_REPO || 'local-ai-desktop'),
    'process.env.GOOSE_BUNDLE_NAME': JSON.stringify(process.env.GOOSE_BUNDLE_NAME || 'Local AI Desktop'),
  },
});

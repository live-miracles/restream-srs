import { defineConfig } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const backendTarget = process.env.RESTREAM_BACKEND_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
    root: 'frontend',
    plugins: [svelte({ preprocess: vitePreprocess({ script: true }) }), tailwindcss()],
    resolve: {
        alias: {
            '@frontend': '/frontend/src',
        },
    },
    server: {
        port: 5173,
        proxy: {
            '/api': backendTarget,
            '/hls': backendTarget,
            '/logo.png': backendTarget,
        },
    },
    build: {
        outDir: '../public/ui',
        emptyOutDir: true,
        manifest: true,
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                login: resolve(__dirname, 'login.html'),
            },
        },
    },
});

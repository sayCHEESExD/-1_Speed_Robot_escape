import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const clientRoot = fileURLToPath(new URL('.', import.meta.url));
const repoAssets = fileURLToPath(new URL('../assets', import.meta.url));

/**
 * Files that live in `assets/` but are never loaded at runtime, so they must
 * not be shipped to browsers. base_rig.fbx is byte-identical to player.fbx.
 */
const UNSHIPPED_ASSETS = ['player/base_rig.fbx'];

/** Drops UNSHIPPED_ASSETS after Vite copies publicDir into the build output. */
const pruneUnusedAssets = (): Plugin => ({
  name: 'robot:prune-unused-assets',
  apply: 'build',
  async closeBundle() {
    for (const relativePath of UNSHIPPED_ASSETS) {
      await rm(join(clientRoot, 'dist', relativePath), { force: true });
    }
  },
});

export default defineConfig({
  plugins: [pruneUnusedAssets()],
  root: clientRoot,
  /**
   * Serve the repo-level `assets/` directory directly as the public root, so
   * the FBX and its texture are reachable at `/player/*` with NO duplicate
   * copies of the source assets inside the client workspace.
   */
  publicDir: repoAssets,
  server: {
    // Deliberately not Vite's default 5173: the previous game in this series
    // runs its own dev server there, and sharing the port means whichever
    // started first silently serves both projects.
    port: 5179,
    strictPort: true,
    // Reachable from a phone on the same LAN for mobile testing.
    host: true,
  },
  preview: {
    port: 4179,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // Browser build budget is 12 MB; warn well before we get close.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          net: ['colyseus.js'],
        },
      },
    },
  },
});

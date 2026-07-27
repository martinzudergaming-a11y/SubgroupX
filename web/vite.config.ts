import fs from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pdfJsRoot = path.resolve(dir, "node_modules/pdfjs-dist");
const pdfJsAssetDirs = ["cmaps", "standard_fonts", "wasm", "iccs"] as const;
const internalBlogEnabled = process.env.AGENT_WEB_INTERNAL_BLOG !== "0";

function pdfJsAssets(): Plugin {
  let outDir = path.resolve(dir, "dist");
  return {
    name: "oiia-pdfjs-assets",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs-assets", (req, res, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent((req.url ?? "").split("?", 1)[0]).replace(/^\/+/, "");
        } catch {
          next();
          return;
        }
        const [assetDir] = pathname.split("/", 1);
        if (!(pdfJsAssetDirs as readonly string[]).includes(assetDir)) {
          next();
          return;
        }
        const file = path.resolve(pdfJsRoot, pathname);
        let isFile = false;
        try { isFile = file.startsWith(pdfJsRoot + path.sep) && fs.statSync(file).isFile(); } catch {  }
        if (!isFile) {
          next();
          return;
        }
        res.setHeader("Cache-Control", "no-cache");
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        else if (file.endsWith(".icc")) res.setHeader("Content-Type", "application/vnd.iccprofile");
        else res.setHeader("Content-Type", "application/octet-stream");
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      const target = path.join(outDir, "pdfjs-assets");
      for (const assetDir of pdfJsAssetDirs) {
        fs.cpSync(path.join(pdfJsRoot, assetDir), path.join(target, assetDir), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.BUILD_VERSION || "dev"),
    __INTERNAL_BLOG_ENABLED__: JSON.stringify(internalBlogEnabled),
  },
  plugins: [react(), tailwindcss(), pdfJsAssets()],
  resolve: {
    alias: {
      "@shared": path.resolve(dir, "../shared/src"),
      "@internal-blog-view": path.resolve(
        dir,
        internalBlogEnabled
          ? "src/dashboard/features/blog/BlogView.tsx"
          : "src/dashboard/features/blog/BlogDisabled.tsx",
      ),
    },
  },
  server: {
    fs: { allow: [path.resolve(dir, ".."), path.resolve(dir)] },
    proxy: {
      "/api": "http://localhost:4317",
      "/ws": { target: "ws://localhost:4317", ws: true },
      "/pty": { target: "ws://localhost:4317", ws: true },
      "/healthz": "http://localhost:4317",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(dir, "index.html"),
        share: path.resolve(dir, "share.html"),
      },
    },
  },
});

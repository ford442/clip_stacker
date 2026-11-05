import { defineConfig, devices } from '@playwright/test';

/**
 * Render regression harness (#346). Runs against the production build
 * (`npm run preview`: CSP-clean, COOP/COEP set) with WebGPU on SwiftShader,
 * so CI needs no GPU. Goldens: `npm run e2e:update-goldens`.
 */
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium-swiftshader',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            // ANGLE-on-Vulkan with SwiftShader Vulkan: the only combination
            // where importExternalTexture / copyExternalImageToTexture work
            // (with --use-angle=swiftshader every frame upload is invalid).
            '--enable-features=Vulkan',
            '--use-vulkan=swiftshader',
            '--use-angle=vulkan',
            '--use-webgpu-adapter=swiftshader',
            '--disable-vulkan-surface',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});

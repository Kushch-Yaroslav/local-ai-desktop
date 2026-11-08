// Modified for Local AI Desktop: repair packaging configuration syntax.
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { resolve } = require('path');

const isLinuxVulkanBuild = process.env.GOOSE_DESKTOP_LINUX_VARIANT === 'vulkan';

let cfg = {
  asar: true,
  executableName: process.env.LOCAL_AI_DESKTOP_DEV_BUILD === '1' ? 'Local AI Desktop' : 'local-ai-desktop',
  // Allow offline packaging from a verified local Electron ZIP when supplied.
  electronZipDir: process.env.ELECTRON_PACKAGER_ELECTRON_ZIP_DIR || undefined,
  extraResource: [
    'src/bin',
    'src/images',
    // Live Browser runtime: self-contained Node bundle + playwright-core data files
    // (resolved at runtime relative to the bundle location).
    'live-browser/dist/live-browser',
    resolve(__dirname, '../../runtime/llama'),
    resolve(__dirname, '../../LICENSE'),
    resolve(__dirname, '../../THIRD_PARTY_NOTICES.md'),
    resolve(__dirname, '../../THIRD_PARTY_NOTICES.local-ai-desktop.md'),
    resolve(__dirname, '../../licenses'),
    resolve(__dirname, '../../assets/ATTRIBUTION.md'),
  ],
  icon: 'src/images/icon',
  // Windows specific configuration
  win32: {
    icon: 'src/images/icon.ico',
    certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
    signingRole: process.env.WINDOW_SIGNING_ROLE,
    rfc3161TimeStampServer: 'http://timestamp.digicert.com',
    signWithParams: '/fd sha256 /tr http://timestamp.digicert.com /td sha256',
  },
  // Protocol registration
  protocols: [
    {
      name: 'Local AI Desktop Protocol',
      schemes: ['local-ai-desktop'],
    },
  ],
  // macOS Info.plist extensions for drag-and-drop support
  extendInfo: {
    // Document types for drag-and-drop support onto dock icon
    CFBundleDocumentTypes: [
      {
        CFBundleTypeName: 'Folders',
        CFBundleTypeRole: 'Viewer',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.directory', 'public.folder'],
      },
    ],
    // Usage descriptions for macOS TCC (Transparency, Consent, and Control)
    NSMicrophoneUsageDescription:
      'Local AI Desktop needs access to your microphone for voice dictation.',
    NSAppleEventsUsageDescription:
      'Local AI Desktop needs access to send Apple Events to control other apps on your behalf.',
  },
};

// macOS code signing and notarization via Electron Forge
// Activated when APPLE_TEAM_ID is set (CI signing builds)
if (process.env.APPLE_TEAM_ID) {
  cfg.osxSign = {
    keychain: process.env.KEYCHAIN_PATH || undefined,
    entitlements: 'entitlements.plist',
    'entitlements-inherit': 'entitlements.plist',
  };
  cfg.osxNotarize = {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  };
}

module.exports = {
  // Preserve the dev launcher output unless a release build explicitly selects another directory.
  outDir: process.env.LOCAL_AI_DESKTOP_FORGE_OUT_DIR || 'out',
  packagerConfig: cfg,
  rebuildConfig: {},
  // Direct Forge invocations must have the same runtime as package/make scripts.
  hooks: {
    generateAssets: async (_forgeConfig, platform, arch) => {
      const { execFileSync } = require('node:child_process');
      execFileSync(process.execPath, [resolve(__dirname, 'live-browser/build.mjs')], {
        env: { ...process.env, LIVE_BROWSER_NO_SOURCEMAP: '1', LAD_LB_TARGET_PLATFORM: platform, LAD_LB_TARGET_ARCH: arch }, stdio: 'inherit',
      });
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32', 'linux'],
      config: {
        arch: process.env.ELECTRON_ARCH === 'x64' ? ['x64'] : ['arm64'],
        options: {
          icon: 'src/images/icon.ico',
        },
      },
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        name: 'local-ai-desktop',
        bin: 'local-ai-desktop',
        maintainer: 'Local AI Desktop contributors',
        homepage: 'https://github.com/Kushch-Yaroslav/local-ai-desktop',
        categories: ['Development'],
        desktopTemplate: './forge.deb.desktop',
        options: {
          icon: 'src/images/icon.png',
          prefix: '/opt',
          ...(isLinuxVulkanBuild ? { depends: ['libvulkan1'] } : {}),
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        name: 'local-ai-desktop',
        bin: 'local-ai-desktop',
        maintainer: 'Local AI Desktop contributors',
        homepage: 'https://github.com/Kushch-Yaroslav/local-ai-desktop',
        categories: ['Development'],
        desktopTemplate: './forge.rpm.desktop',
        options: {
          icon: 'src/images/icon.png',
          prefix: '/opt',
          ...(isLinuxVulkanBuild ? { requires: ['vulkan-loader'] } : {}),
        },
      },
    },
    {
      name: '@electron-forge/maker-flatpak',
      config: {
        options: {
          id: 'io.github.Kushch-Yaroslav.local-ai-desktop',
          categories: ['Development'],
          mimeType: ['x-scheme-handler/local-ai-desktop'],
          icon: {
            scalable: 'src/images/icon.svg',
            '512x512': 'src/images/icon-512.png',
          },
          homepage: 'https://github.com/Kushch-Yaroslav/local-ai-desktop',
          runtimeVersion: '25.08',
          baseVersion: '25.08',
          bin: 'local-ai-desktop',
          modules: [
            {
              name: 'libbz2-shim',
              buildsystem: 'simple',
              'build-commands': [
                // Create the lib directory in the app bundle
                'mkdir -p /app/lib',
                // Point to the actual library in the 25.08 runtime
                // We use a wildcard to handle multi-arch paths (x86_64-linux-gnu, etc)
                'ln -s $(find /usr/lib -name "libbz2.so.1" | head -n 1) /app/lib/libbz2.so.1.0',
              ],
            },
            {
              name: 'git',
              buildsystem: 'simple',
              'build-commands': [
                'mkdir -p /app/bin /app/libexec/git-core',
                'cp /usr/bin/git /app/bin/git',
                'cp /usr/libexec/git-core/git-remote-https /app/libexec/git-core/git-remote-https 2>/dev/null || true',
              ],
            },
          ],
          finishArgs: [
            '--share=ipc',
            '--socket=x11',
            '--socket=wayland',
            '--device=dri',
            '--share=network',
            '--filesystem=home',
            '--talk-name=org.freedesktop.Notifications',
            '--socket=session-bus',
            '--socket=system-bus',
            // This ensures the app looks in our shim folder first
            '--env=LD_LIBRARY_PATH=/app/lib',
            '--env=GIT_EXEC_PATH=/app/libexec/git-core',
          ],
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          {
            entry: 'src/main.ts',
            config: 'vite.main.config.mts',
          },
          {
            entry: 'src/preload.ts',
            config: 'vite.preload.config.mts',
          },
        ],
        renderer: [
          {
            name: 'main_window',
            config: 'vite.renderer.config.mts',
          },
        ],
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

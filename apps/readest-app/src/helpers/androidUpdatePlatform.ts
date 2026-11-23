const ANDROID_UPDATE_PLATFORMS: Record<string, { key: string; assetArch: string }> = {
  aarch64: { key: 'android-arm64', assetArch: 'arm64' },
  arm: { key: 'android-armv7', assetArch: 'armv7' },
  armv7: { key: 'android-armv7', assetArch: 'armv7' },
  x86_64: { key: 'android-x86_64', assetArch: 'x64' },
  x86: { key: 'android-i686', assetArch: 'x86' },
  i686: { key: 'android-i686', assetArch: 'x86' },
};

export const getAndroidUpdatePlatform = (
  arch: string,
  platforms: Record<string, unknown> = {},
): { key: string; assetArch: string } | null => {
  const platform = ANDROID_UPDATE_PLATFORMS[arch];
  if (platform && platform.key in platforms) {
    return platform;
  }
  // Upstream's combined x86 APK takes precedence over its armv7 universal alias.
  if (['x86_64', 'i686', 'x86'].includes(arch) && 'android-legacy' in platforms) {
    return { key: 'android-legacy', assetArch: 'legacy' };
  }
  return 'android-universal' in platforms
    ? { key: 'android-universal', assetArch: 'universal' }
    : null;
};

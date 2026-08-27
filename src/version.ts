/**
 * The one place the version is written down. `package.json`, the plugin manifest
 * and the marketplace entry are pinned to it by `version.test.ts`, so a release
 * bump that misses a file fails the test suite instead of shipping.
 */
export const VERSION = '0.1.5'

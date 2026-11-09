import { expect, it } from 'vitest'
import { resolveReleaseVersion } from '../../migration/installer/resolve-release-version.mjs'

it('uses the source version for matching version tags', () => {
 expect(resolveReleaseVersion('2.0.2', '', 'refs/tags/v2.0.2', 'push')).toBe('2.0.2')
})
it('refuses master pushes, mismatched tags and prereleases', () => {
 for (const ref of ['refs/heads/master','refs/tags/v2.0.1','refs/tags/v2.0.2-beta']) {
  expect(() => resolveReleaseVersion('2.0.2', '', ref, 'push')).toThrow('tag must match')
 }
 expect(() => resolveReleaseVersion('2.0.2-beta', '', 'refs/tags/v2.0.2-beta', 'push')).toThrow('stable')
})
it('keeps manual candidate builds pinned to the source version', () => {
 expect(resolveReleaseVersion('2.0.2', '2.0.2', 'refs/heads/master', 'workflow_dispatch')).toBe('2.0.2')
 expect(() => resolveReleaseVersion('2.0.2', '2.0.1', 'refs/heads/master', 'workflow_dispatch')).toThrow('does not match')
 expect(() => resolveReleaseVersion('2.0.2', '', 'refs/heads/master', 'pull_request')).toThrow('manual dispatch')
})

// Validate archive and manifest paths before filesystem access.
import { isAbsolute, normalize, relative, resolve, sep } from 'path'

// Reject absolute paths and parent traversal before resolving.
export function assertSafeRelativePath(
  relPath: string,
  label: string,
  onViolation: (reason: string) => never
): void {
  if (isAbsolute(relPath)) {
    onViolation(`${label} must be a relative path, got an absolute path: ${relPath}`)
  }
  const segments = normalize(relPath).split(/[\\/]+/)
  if (segments.includes('..')) {
    onViolation(`${label} must not contain '..' path segments: ${relPath}`)
  }
}

// Use relative paths to support drive roots and UNC shares.
export function isWithinRoot(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target))
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path))
}

// Reject resolved paths outside the installation root.
export function resolveWithinRoot(
  root: string,
  relPath: string,
  label: string,
  onViolation: (reason: string) => never
): string {
  assertSafeRelativePath(relPath, label, onViolation)
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, relPath)
  if (!isWithinRoot(resolvedRoot, resolvedTarget)) {
    onViolation(`${label} resolves outside of its root directory: ${relPath}`)
  }
  return resolvedTarget
}

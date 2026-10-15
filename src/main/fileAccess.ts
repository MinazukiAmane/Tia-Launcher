// Retry filesystem access only; never repeat native patch generation.
export async function retryTransientFileAccess<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || (process.platform === 'win32' && code === 'UNKNOWN')
      if (!transient || attempt >= 8) throw error
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

/// <reference types="vite/client" />
import type { CsoreAPI } from '../../preload'

declare global {
  interface Window {
    csore: CsoreAPI
  }
}

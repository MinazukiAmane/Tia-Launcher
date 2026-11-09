/// <reference types="vite/client" />
import type { CsoreAPI } from './tauriBridge'

declare global {
  interface Window {
    csore: CsoreAPI
  }
}

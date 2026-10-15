export const IPC_UPDATE = {
  STATE: 'update:state',
  AVAILABLE: 'update:available',
  DOWNLOAD_PROGRESS: 'update:download-progress',
  DOWNLOADED: 'update:downloaded',
  NOT_AVAILABLE: 'update:not-available',
  ERROR: 'update:error',
  START_DOWNLOAD: 'update:start-download',
  QUIT_AND_INSTALL: 'update:quit-and-install',
  CHECK: 'update:check',
  GET_STATE: 'update:get-state'
} as const

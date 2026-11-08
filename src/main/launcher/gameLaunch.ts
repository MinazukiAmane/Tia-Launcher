import { activeGame } from '../activeGame'
import { prepareCSORELaunch, type LaunchSession } from './csoreLaunch'
import { prepareNativeGameLaunch } from './nativeGameLaunch'
export function prepareGameLaunch(exePath: string, args: string[]): Promise<LaunchSession> {
  return activeGame().biz === 'cedar_global' ? prepareNativeGameLaunch(exePath, args) : prepareCSORELaunch(exePath, args)
}

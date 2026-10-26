import { activeGame } from '../activeGame'
import { prepareFlagLaunch, type FlagLaunch } from './flagLaunch'
import { prepareNativeGameLaunch } from './nativeGameLaunch'
export function prepareGameLaunch(exePath: string, args: string[]): Promise<FlagLaunch> {
  return activeGame().biz === 'cedar_global' ? prepareNativeGameLaunch(exePath, args) : prepareFlagLaunch(exePath, args)
}

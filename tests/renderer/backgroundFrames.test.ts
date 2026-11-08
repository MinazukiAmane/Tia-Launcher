import { expect, it } from 'vitest'
import { orderedFrameUrls } from '../../src/renderer/src/backgroundFrames'

it('orders numbered frames naturally and ignores non-frame assets', () => {
 expect(orderedFrameUrls({ 'frame10.png': 'ten', 'frame2.png': 'two', 'frame0001.png': 'one', 'poster.png': 'poster', 'frame3.gif': 'gif' })).toEqual(['one', 'two', 'ten'])
})

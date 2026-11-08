import { expect, it } from 'vitest'
import messages from '../../src/shared/mediaMessages.json'
import { translate } from '../../src/renderer/src/i18n'
it('provides all media controls, conversion consent and errors in every launcher language', () => {
  for (const [key, values] of Object.entries(messages)) {
    expect(values).toHaveLength(5)
    for (const [index, language] of ['id', 'zh-CN', 'ko', 'ja', 'jv'].entries()) {
      expect(values[index].trim()).not.toBe('')
      expect(translate(key, language as 'id')).toBe(values[index])
    }
  }
})

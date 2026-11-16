import { describe, expect, test } from 'bun:test'
import { ar } from '../../src/i18n/ar'
import { en } from '../../src/i18n/en'
import { es } from '../../src/i18n/es'
import { hi } from '../../src/i18n/hi'
import { id } from '../../src/i18n/id'
import { ru } from '../../src/i18n/ru'
import { zh } from '../../src/i18n/zh'

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
const locales = { zh, id, hi, es, ar, ru } as const

describe('dashboard translations', () => {
  for (const [code, messages] of Object.entries(locales)) {
    test(`${code}: same keys as English, no empty strings, same placeholders`, () => {
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort())
      for (const [key, value] of Object.entries(messages)) {
        expect(value.trim().length, `${code} ${key} is empty`).toBeGreaterThan(0)
        expect(placeholders(value), `${code} ${key} placeholders`).toEqual(placeholders((en as Record<string, string>)[key]))
      }
    })
  }

  test('translations are not just copies of English (except proper nouns and symbols)', () => {
    const same = (messages: Record<string, string>) => Object.keys(en).filter((k) => messages[k] === (en as Record<string, string>)[k])
    for (const messages of Object.values(locales)) {
      // Allow a handful of identical strings (USDC, WebSocket, ROI, '-').
      expect(same(messages).length).toBeLessThan(25)
    }
  })

  test('the confirmation phrase required by the API is untouched in every language', () => {
    for (const messages of Object.values(locales)) expect(messages['ct.confirmPrompt']).toContain('ENABLE TESTNET TRADING')
    expect(en['ct.confirmPrompt']).toContain('ENABLE TESTNET TRADING')
  })
})

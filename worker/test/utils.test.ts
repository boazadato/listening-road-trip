import { describe, it, expect } from 'vitest'
import { generateShortCode, generateId } from '../src/utils'

describe('generateShortCode', () => {
  it('returns 6 uppercase alphanumeric characters (no ambiguous chars)', () => {
    const code = generateShortCode()
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })

  it('generates mostly-unique codes', () => {
    const codes = new Set(Array.from({ length: 100 }, generateShortCode))
    expect(codes.size).toBeGreaterThan(95)
  })
})

describe('generateId', () => {
  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, generateId))
    expect(ids.size).toBe(100)
  })
})

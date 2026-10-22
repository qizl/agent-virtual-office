import { describe, it, expect } from 'vitest'
import { envelopeIsNewer } from '../src/inference/mawIntegration.js'

// (server_epoch, seq) total order: delayed bootstrap GETs must never overwrite
// newer SSE state, and envelopes from a previous server lifetime (lower epoch)
// must never re-activate the view.

describe('envelopeIsNewer', () => {
  it('accepts anything when no envelope has been applied yet', () => {
    expect(envelopeIsNewer({ server_epoch: 10, seq: 1 }, null)).toBe(true)
  })

  it('orders by epoch first: an older-epoch envelope is never newer', () => {
    expect(envelopeIsNewer({ server_epoch: 9, seq: 999 }, [10, 1])).toBe(false)
    expect(envelopeIsNewer({ server_epoch: 11, seq: 1 }, [10, 999])).toBe(true)
  })

  it('orders by seq within one epoch: a delayed GET cannot overwrite newer SSE state', () => {
    expect(envelopeIsNewer({ server_epoch: 10, seq: 4 }, [10, 5])).toBe(false)
    expect(envelopeIsNewer({ server_epoch: 10, seq: 6 }, [10, 5])).toBe(true)
    expect(envelopeIsNewer({ server_epoch: 10, seq: 5 }, [10, 5])).toBe(true) // full-set replay is idempotent
  })

  it('passes malformed envelopes through so the validator owns the rejection', () => {
    expect(envelopeIsNewer(null, [10, 5])).toBe(false)
    expect(envelopeIsNewer({}, [10, 5])).toBe(true)
    expect(envelopeIsNewer({ server_epoch: 'x', seq: 'y' }, [10, 5])).toBe(true)
  })
})

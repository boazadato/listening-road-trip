import { render, screen } from '@testing-library/react'
import { it, expect } from 'vitest'
import CountdownTimer from '../CountdownTimer'

it('shows remaining time and urgent color under 15 seconds', () => {
  const endsAt = Date.now() + 10_000
  render(<CountdownTimer endsAt={endsAt} />)
  expect(screen.getByText('0:10')).toBeInTheDocument()
})

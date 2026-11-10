import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditLowBanner } from './CreditLowBanner';

const mocks = vi.hoisted(() => ({
  state: 'ok' as 'ok' | 'credit_low',
  status: null as null | { nextCheckAt?: string },
}));

vi.mock('../hooks/useClaudeStatus', () => ({
  useClaudeStatus: () => ({ connected: true, state: mocks.state, status: mocks.status, loading: false, error: null, refresh: async () => {} }),
}));

describe('CreditLowBanner', () => {
  beforeEach(() => {
    mocks.state = 'ok';
    mocks.status = null;
  });

  it('renders nothing while the balance is fine', () => {
    const { container } = render(<CreditLowBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an alert with the next check time while credit is low', () => {
    mocks.state = 'credit_low';
    mocks.status = { nextCheckAt: '2026-11-09T15:30:00.000Z' };
    render(<CreditLowBanner />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Claude 余额不足');
    expect(alert).toHaveTextContent('下次检查：');
    expect(alert.className).not.toMatch(/orange/);
  });

  it('omits the next-check line when the server sent none', () => {
    mocks.state = 'credit_low';
    mocks.status = {};
    render(<CreditLowBanner />);
    expect(screen.getByRole('alert')).not.toHaveTextContent('下次检查');
  });
});

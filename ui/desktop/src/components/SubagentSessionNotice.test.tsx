import { fireEvent, render, screen, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import { SubagentSessionNotice } from './SubagentSessionNotice';

describe('SubagentSessionNotice', () => {
  it('explains event-driven refresh and loads the latest progress on click', () => {
    const onRefresh = vi.fn();
    render(<SubagentSessionNotice refreshing={false} onRefresh={onRefresh} />, {
      wrapper: IntlTestWrapper,
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Saved subagent progress refreshes as execution events arrive.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load latest progress' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('disables loading while a load is in progress', () => {
    render(<SubagentSessionNotice refreshing onRefresh={vi.fn()} />, {
      wrapper: IntlTestWrapper,
    });

    expect(screen.getByRole('button', { name: 'Load latest progress' })).toBeDisabled();
  });
});

it('refreshes an open child history on its execution event without polling', () => {
  const refresh = vi.fn();
  render(<SubagentSessionNotice sessionId="live-child" refreshing={false} onRefresh={refresh} />, {
    wrapper: IntlTestWrapper,
  });
  act(() =>
    window.dispatchEvent(
      new CustomEvent('goose:subagent-updated', { detail: { id: 'other-child' } })
    )
  );
  expect(refresh).not.toHaveBeenCalled();
  act(() =>
    window.dispatchEvent(
      new CustomEvent('goose:subagent-updated', { detail: { id: 'live-child' } })
    )
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it('coalesces updates arriving during a replay into one trailing refresh', () => {
  const refresh = vi.fn();
  const view = render(
    <SubagentSessionNotice sessionId="busy-child" refreshing onRefresh={refresh} />,
    { wrapper: IntlTestWrapper }
  );
  act(() => {
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(
        new CustomEvent('goose:subagent-updated', { detail: { id: 'busy-child' } })
      );
    }
  });
  expect(refresh).not.toHaveBeenCalled();
  view.rerender(
    <SubagentSessionNotice sessionId="busy-child" refreshing={false} onRefresh={refresh} />
  );
  expect(refresh).toHaveBeenCalledOnce();
});

import { fireEvent, render, screen } from '@/tests/test-utils';
import { allTimezones } from 'react-timezone-select';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeZoneSelector } from './timezone-selector';

// Polyfill ResizeObserver for Radix UI
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const field = () => screen.getByRole('combobox');

const pinDate = (date: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(date));
};

afterEach(() => {
  vi.useRealTimers();
});

// The list keeps one zone for each offset and daylight saving rule, and offsets move with daylight
// saving, so which zones it leaves out depends on the date. Check a date on each side of it.
describe.each(['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z'])('TimeZoneSelector on %s', (date) => {
  beforeEach(() => {
    pinDate(date);
  });

  it.each(Object.entries(allTimezones))('shows %s by its own name', (timeZone, name) => {
    render(<TimeZoneSelector timeZone={timeZone} onChange={vi.fn()} />);

    expect(field()).toHaveTextContent(name);
  });
});

describe('TimeZoneSelector', () => {
  beforeEach(() => {
    pinDate('2026-10-01T12:00:00Z');
  });

  it('shows Asia/Karachi, which the list folds into Asia/Yekaterinburg, by its own label', () => {
    render(<TimeZoneSelector timeZone="Asia/Karachi" onChange={vi.fn()} />);

    expect(field()).toHaveTextContent('(GMT+5:00) Islamabad, Karachi, Tashkent (PKT)');
  });

  it('lists the saved zone once, checked, among the zones with its offset', () => {
    render(<TimeZoneSelector timeZone="Asia/Karachi" onChange={vi.fn()} />);
    fireEvent.click(field());

    const labels = screen.getAllByRole('option').map((option) => option.textContent);
    const karachi = labels.indexOf('(GMT+5:00) Islamabad, Karachi, Tashkent (PKT)');
    expect(labels.filter((label) => label?.includes('Karachi'))).toHaveLength(1);
    expect(labels.slice(karachi - 1, karachi + 2)).toEqual([
      '(GMT+5:00) Ekaterinburg (YEKT)',
      '(GMT+5:00) Islamabad, Karachi, Tashkent (PKT)',
      '(GMT+5:30) Chennai, Kolkata, Mumbai, New Delhi (IST)',
    ]);
    expect(screen.getByRole('option', { name: '(GMT+5:00) Islamabad, Karachi, Tashkent (PKT)' })).toHaveAttribute('data-state', 'checked');
  });

  it('shows a zone missing from the list by the entry that names it', () => {
    render(<TimeZoneSelector timeZone="Europe/Berlin" onChange={vi.fn()} />);

    expect(field()).toHaveTextContent('(GMT+2:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna (CEST)');
  });

  it('shows a zone none of the entries shares an offset with by its name', () => {
    render(<TimeZoneSelector timeZone="Pacific/Kiritimati" onChange={vi.fn()} />);

    expect(field()).toHaveTextContent('Pacific/Kiritimati');
  });

  it.each([
    ['Etc/GMT', 'Etc/GMT'],
    ['no zone', undefined],
    ['an empty zone', ''],
    ['UTC', 'UTC'],
    ['an unknown name', 'foo'],
    ['an unknown zone', 'Mars/Olympus_Mons'],
  ])('shows UTC for %s', (_, timeZone) => {
    render(<TimeZoneSelector timeZone={timeZone} onChange={vi.fn()} />);

    expect(field()).toHaveTextContent('(GMT+0:00) UTC (GMT)');
  });

  it.each(['Asia/Karachi', 'Europe/Berlin', 'Pacific/Kiritimati'])('leaves %s alone until a zone is picked', (timeZone) => {
    const onChange = vi.fn();
    render(<TimeZoneSelector timeZone={timeZone} onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports the zone that is picked', () => {
    const onChange = vi.fn();
    render(<TimeZoneSelector timeZone="Asia/Karachi" onChange={onChange} />);
    fireEvent.click(field());
    fireEvent.click(screen.getByRole('option', { name: '(GMT+9:00) Seoul (KST)' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith('Asia/Seoul');
  });
});

import { describe, expect, it } from 'vitest';
import { domainListNoteFor } from './domain-list-note';

describe('domainListNoteFor', () => {
  it('says the list is loading while the first request is in flight', () => {
    expect(domainListNoteFor({ data: undefined, isError: false, isFetching: true })).toBe('loading');
  });

  it('says the list is loading again while a retry is in flight', () => {
    expect(domainListNoteFor({ data: { supported: false }, isError: false, isFetching: true })).toBe('loading');
    expect(domainListNoteFor({ data: undefined, isError: true, isFetching: true })).toBe('loading');
  });

  it('calls a list the Hub could not get unavailable, although it arrived as a 200', () => {
    expect(domainListNoteFor({ data: { supported: false }, isError: false, isFetching: false })).toBe('unavailable');
  });

  it('calls a failed request unavailable', () => {
    expect(domainListNoteFor({ data: undefined, isError: true, isFetching: false })).toBe('unavailable');
  });

  it('says nothing more is offered when the Portal answered', () => {
    expect(domainListNoteFor({ data: { supported: true }, isError: false, isFetching: false })).toBe('none-offered');
  });

  it('says nothing when the list was never asked for', () => {
    expect(domainListNoteFor({ data: undefined, isError: false, isFetching: false })).toBeUndefined();
  });
});

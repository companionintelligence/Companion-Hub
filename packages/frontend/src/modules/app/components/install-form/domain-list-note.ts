/**
 * Why the subdomain field shows its domain as plain text rather than a picker.
 *
 * The picker appears only once there is a domain to offer, and until then the
 * suffix reads the same whether the list is on its way, failed, or offers
 * nothing. Each of those means something different to the person filling the
 * form, so the field marks which one it is.
 *
 * - `loading`: the request is in flight, including a retry.
 * - `unavailable`: the Hub never got a list (the request failed, or the Hub
 *   could not ask Companion Portal). Retrying can help.
 * - `none-offered`: Companion Portal answered and offers nothing else.
 * - `undefined`: nothing was asked, or a Hub too old to say whether it got an
 *   answer; there is nothing to say.
 */
export type DomainListNote = 'loading' | 'unavailable' | 'none-offered' | undefined;

interface DomainListQuery {
  data?: { supported?: boolean };
  isError: boolean;
  isFetching: boolean;
}

/**
 * Only meaningful while the picker has nothing to offer; a field with domains to
 * choose from shows the picker and ignores this.
 */
export function domainListNoteFor({ data, isError, isFetching }: DomainListQuery): DomainListNote {
  if (isFetching) {
    return 'loading';
  }

  // `supported: false` is the Hub saying it could not get the list, the same
  // contract as the custom-domain list. It arrives as a 200, so `isError` alone
  // would pass it off as a Portal that offers nothing.
  if (isError || data?.supported === false) {
    return 'unavailable';
  }

  // Only a Hub that says it got an answer can say nothing is offered. A Hub
  // predating `supported` (the phone app talks to older Hubs) sends an empty list
  // for a failure too, and "nothing to choose from" would be a guess.
  return data?.supported === true ? 'none-offered' : undefined;
}

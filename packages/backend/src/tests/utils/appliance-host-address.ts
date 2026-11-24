import type * as ThisHostAddress from '@/common/helpers/this-host-address';

/** `/proc/net/route` in a Hub container whose default gateway is 172.18.0.1. */
const APPLIANCE_ROUTES = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t00000000\t010012AC\t0003\t0\t0\t0\t00000000';

/**
 * `@/common/helpers/this-host-address` as it behaves on an appliance: the Hub in a container whose
 * default gateway is 172.18.0.1, where the setup service's requests from the host arrive from.
 *
 *     vi.mock('@/common/helpers/this-host-address', async (importOriginal) =>
 *       (await import('@/tests/utils/appliance-host-address')).onAppliance(await importOriginal()));
 */
export function onAppliance(actual: typeof ThisHostAddress): typeof ThisHostAddress {
  return {
    ...actual,
    isThisHostAddress: actual.createThisHostAddressCheck({ inContainer: () => true, readIpv4Routes: () => APPLIANCE_ROUTES }),
  };
}

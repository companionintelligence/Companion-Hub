import { describe, expect, it, vi } from 'vitest';
import { createThisHostAddressCheck, parseIpv4DefaultGateway } from '../this-host-address';

/**
 * `/proc/net/route` as read inside a container on two Docker networks, the second given
 * `gw_priority: 1` the way docker-compose.prod.yml gives the Hub's network. The default route goes
 * through that network's gateway, 172.22.0.1.
 */
const CONTAINER_ROUTES = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT                                                       ',
  'eth1\t00000000\t010016AC\t0003\t0\t0\t0\t00000000\t0\t0\t0                                                                               ',
  'eth0\t000015AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0                                                                               ',
  'eth1\t000016AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0                                                                               ',
].join('\n');
const GATEWAY = '172.22.0.1';

function check(options: { inContainer?: boolean; routes?: () => string; now?: () => number } = {}) {
  const readIpv4Routes = vi.fn(options.routes ?? (() => CONTAINER_ROUTES));
  const isThisHost = createThisHostAddressCheck({ inContainer: () => options.inContainer ?? true, readIpv4Routes }, options.now);
  return { isThisHost, readIpv4Routes };
}

describe('parseIpv4DefaultGateway', () => {
  it("reads the default route's gateway from a container's route table", () => {
    expect(parseIpv4DefaultGateway(CONTAINER_ROUTES)).toBe(GATEWAY);
  });

  it('takes the default route with the lowest metric', () => {
    const host = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
      'eth0\t00000000\t0100000A\t0003\t0\t0\t100\t00000000\t0\t0\t0',
      'eth1\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
    ].join('\n');

    expect(parseIpv4DefaultGateway(host)).toBe('10.0.0.1');
  });

  it('skips a route that is down, has no gateway or is not the default', () => {
    const header = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';
    const table = (...lines: string[]) => [header, ...lines].join('\n');

    // RTF_GATEWAY without RTF_UP.
    expect(parseIpv4DefaultGateway(table('eth0\t00000000\t010016AC\t0002\t0\t0\t0\t00000000\t0\t0\t0'))).toBeNull();
    // RTF_UP without RTF_GATEWAY.
    expect(parseIpv4DefaultGateway(table('eth0\t00000000\t010016AC\t0001\t0\t0\t0\t00000000\t0\t0\t0'))).toBeNull();
    expect(parseIpv4DefaultGateway(table('eth0\t00000000\t00000000\t0003\t0\t0\t0\t00000000\t0\t0\t0'))).toBeNull();
    expect(parseIpv4DefaultGateway(table('eth0\t000016AC\t010016AC\t0003\t0\t0\t0\t0000FFFF\t0\t0\t0'))).toBeNull();
    expect(parseIpv4DefaultGateway(table('eth0\t00000000\t010016AC\t0003\t0\t0\t0\t0000FFFF\t0\t0\t0'))).toBeNull();
  });

  it('finds nothing in a table that is empty, has only its header or is not a route table', () => {
    expect(parseIpv4DefaultGateway('')).toBeNull();
    expect(parseIpv4DefaultGateway(CONTAINER_ROUTES.split('\n')[0] ?? '')).toBeNull();
    expect(parseIpv4DefaultGateway('Iface\tDestination\tGateway\neth0\t00000000\tnot-hex!\t0003\t0\t0\t0\t00000000')).toBeNull();
    // The first line is the header, so it is never read as a route.
    expect(parseIpv4DefaultGateway('eth1\t00000000\t010016AC\t0003\t0\t0\t0\t00000000\t0\t0\t0')).toBeNull();
  });
});

describe('createThisHostAddressCheck', () => {
  it.each(['127.0.0.1', '127.3.2.1', '::ffff:127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])('admits loopback %s without reading the routes', (address) => {
    const { isThisHost, readIpv4Routes } = check({ inContainer: false });

    expect(isThisHost(address)).toBe(true);
    expect(readIpv4Routes).not.toHaveBeenCalled();
  });

  it("admits the container's default gateway, as Node reports it on an IPv4 or a dual-stack socket", () => {
    const { isThisHost } = check();

    expect(isThisHost(GATEWAY)).toBe(true);
    expect(isThisHost(`::ffff:${GATEWAY}`)).toBe(true);
  });

  it("refuses a machine on the LAN and a container on the gateway's network", () => {
    const { isThisHost } = check();

    expect(isThisHost('192.168.1.50')).toBe(false);
    expect(isThisHost('172.22.0.7')).toBe(false);
    // The gateway of the container's other network, which carries no default route.
    expect(isThisHost('172.21.0.1')).toBe(false);
    expect(isThisHost('fd00::1')).toBe(false);
  });

  it('refuses an address it cannot read', () => {
    const { isThisHost } = check();

    expect(isThisHost(undefined)).toBe(false);
    expect(isThisHost('')).toBe(false);
    expect(isThisHost('127.evil')).toBe(false);
  });

  it("does not use the gateway outside a container, where it is the LAN's router", () => {
    const { isThisHost, readIpv4Routes } = check({ inContainer: false });

    expect(isThisHost(GATEWAY)).toBe(false);
    expect(readIpv4Routes).not.toHaveBeenCalled();
  });

  it('asks whether it runs in a container once', () => {
    const inContainer = vi.fn(() => true);
    const isThisHost = createThisHostAddressCheck({ inContainer, readIpv4Routes: () => CONTAINER_ROUTES });

    expect(isThisHost(GATEWAY)).toBe(true);
    expect(isThisHost('192.168.1.50')).toBe(false);
    expect(inContainer).toHaveBeenCalledTimes(1);
  });

  it('refuses the gateway but still admits loopback when the route table cannot be read', () => {
    const { isThisHost } = check({
      routes: () => {
        throw new Error('EACCES');
      },
    });

    expect(isThisHost(GATEWAY)).toBe(false);
    expect(isThisHost('127.0.0.1')).toBe(true);
  });

  it('keeps the gateway it read for 30 seconds', () => {
    let now = 1_000;
    const { isThisHost, readIpv4Routes } = check({ now: () => now });

    expect(isThisHost(GATEWAY)).toBe(true);
    now += 29_999;
    expect(isThisHost(GATEWAY)).toBe(true);
    expect(readIpv4Routes).toHaveBeenCalledTimes(1);

    // The container's networks were reconnected and its gateway changed.
    readIpv4Routes.mockReturnValue(CONTAINER_ROUTES.replace('010016AC', '010017AC'));
    now += 1;
    expect(isThisHost(GATEWAY)).toBe(false);
    expect(isThisHost('172.23.0.1')).toBe(true);
    expect(readIpv4Routes).toHaveBeenCalledTimes(2);
  });
});

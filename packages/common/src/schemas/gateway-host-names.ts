import { z } from 'zod';

/**
 * Suffixes only a local network resolves: mDNS (`.local`), what home routers hand out (`.lan`,
 * `.home`, `.home.arpa`) and the name ICANN reserved for private use (`.internal`). A page on another
 * site cannot point a name under one of them at an address, so Companion Memory's gateway may answer
 * to all of them when its port is open on the network (`gatewayAllowedHosts`).
 */
export const LAN_HOST_SUFFIXES: readonly string[] = ['.local', '.lan', '.home', '.home.arpa', '.internal'];

/** Most names an operator may add to the ones Companion Memory's gateway answers to. */
export const MAX_GATEWAY_HOST_NAMES = 20;

const HOST_NAME = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * A name the operator adds to those Companion Memory's gateway answers to (`gatewayHostNames`): a host
 * name such as `kyle-pc.fritz.box`, or one after a dot, which covers every name under it
 * (`.fritz.box`). Lower case, no scheme, port or path: the gateway compares it with the Host header's
 * name. A suffix of one label covers a whole top-level domain and is taken only for the LAN ones
 * ({@link LAN_HOST_SUFFIXES}). The backend also refuses a suffix that is a public one, such as
 * `.co.uk` (`gatewayHostNameRefusal`).
 */
export const gatewayHostNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(HOST_NAME, 'A host name, such as memory.example.lan, or .example.lan for every name under it')
  .refine((name) => !name.startsWith('.') || name.slice(1).includes('.') || LAN_HOST_SUFFIXES.includes(name), {
    message: 'A suffix of one label covers a whole top-level domain',
  });

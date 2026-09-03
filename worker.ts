import { DurableObject } from 'cloudflare:workers';

interface Env {
  APP_CONTAINER: DurableObjectNamespace;
}

/**
 * The AppContainer Durable Object class.
 * This object controls the container instance.
 */
export class AppContainer extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    // This is where you would proxy requests to the container
    // or handle container lifecycle events.
    // For now, we return a simple status message.

    // Note: To proxy to the container, you would typically use internal networking
    // or specific container bindings if available in your platform version.
    return new Response('Container is running (managed by AppContainer DO)');
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // Generate an ID for the container DO.
    // For a singleton service, we can use a hardcoded name.
    const id = env.APP_CONTAINER.idFromName('default');
    const stub = env.APP_CONTAINER.get(id);

    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

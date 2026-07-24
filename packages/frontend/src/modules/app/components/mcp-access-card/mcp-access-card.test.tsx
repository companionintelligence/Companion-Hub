import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AppDetails, AppInfo } from '@/types/app.types';
import { McpAccessCard } from './mcp-access-card';

const makeInfo = (mcp?: AppInfo['mcp']): AppInfo =>
  ({
    id: 'fetch-mcp',
    urn: 'fetch-mcp:ci-marketplace',
    name: 'Fetch MCP',
    no_gui: true,
    mcp,
  }) as unknown as AppInfo;

const runningApp = { status: 'running' } as unknown as AppDetails;

const renderCard = (info: AppInfo, app?: AppDetails | null) =>
  render(
    <MemoryRouter>
      <McpAccessCard app={app} info={info} />
    </MemoryRouter>,
  );

describe('McpAccessCard', () => {
  it('renders nothing for apps without an mcp block', () => {
    const { container } = renderCard(makeInfo(undefined), runningApp);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows transport and the tool manifest', () => {
    renderCard(
      makeInfo({
        transport: 'stdio',
        command: 'uvx',
        args: ['mcp-server-fetch'],
        manifest: { tools: [{ name: 'fetch', description: 'Fetch a URL and return Markdown.' }] },
      }),
      runningApp,
    );

    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.getByText('fetch')).toBeInTheDocument();
    expect(screen.getByText('Fetch a URL and return Markdown.')).toBeInTheDocument();
  });

  it('shows the Hub endpoint and client config once installed', () => {
    renderCard(makeInfo({ transport: 'stdio', command: 'uvx', args: [] }), runningApp);
    expect(screen.getByText(`${window.location.origin}/api/mcp`)).toBeInTheDocument();
  });

  it('hides connection details when the app is not installed', () => {
    renderCard(makeInfo({ transport: 'stdio', command: 'uvx', args: [] }), null);
    expect(screen.queryByText(`${window.location.origin}/api/mcp`)).not.toBeInTheDocument();
  });
});

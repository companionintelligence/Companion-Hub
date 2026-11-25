import type { CuratedModel } from '@ci-hub/common/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentModelFitNotice } from '../agent-model-fit-notice';

const llm = (id: string, displayName: string, tools: boolean, diskMb: number, backend: CuratedModel['backend'] = 'ollama') =>
  ({
    id,
    backend,
    modality: 'llm',
    displayName,
    metadata: { capabilities: { tools } },
    requirements: { diskMb },
    runtime: { contextWindow: 262144, memoryFootprintMb: diskMb + 800 },
  }) as unknown as CuratedModel;

const gemma270m = llm('gemma3-270m', 'Gemma 3 270M', false, 292);
const minimax = llm('minimax-m2-community-230b', 'MiniMax M2 230B', true, 53759);
const gemma12b = llm('gemma4-12b', 'Gemma 4 12B', true, 7650);
const lists = {
  availableModels: [gemma270m, gemma12b, minimax],
  recommendedModels: [minimax, gemma12b],
  installedIds: ['gemma3-270m'],
  tickedIds: ['gemma3-270m'],
};

describe('AgentModelFitNotice', () => {
  it('names the smallest recommended model the Hub will download for the agent, with its size', () => {
    render(<AgentModelFitNotice model={gemma270m} frameworks={['openclaw']} backend="ollama" {...lists} />);
    expect(screen.getByTestId('agent-model-unsuited-openclaw')).toHaveTextContent(
      'The Hub will download Gemma 4 12B (7.5 GB) for OpenClaw, the smallest recommended model it can use.',
    );
    expect(screen.queryByText(/MiniMax/)).not.toBeInTheDocument();
  });

  // vLLM serves the one model it started with. An app's handout starts no download on oMLX.
  it.each(['vllm', 'omlx'] as const)('does not promise a download on %s', (backend) => {
    const onEngine = {
      ...lists,
      availableModels: lists.availableModels.map((m) => ({ ...m, backend })),
      recommendedModels: lists.recommendedModels.map((m) => ({ ...m, backend })),
    };
    render(<AgentModelFitNotice model={{ ...gemma270m, backend }} frameworks={['openclaw', 'hermes']} backend={backend} {...onEngine} />);
    expect(screen.getByTestId('agent-model-unsuited-openclaw')).toHaveTextContent(
      'On this engine the Hub can only give OpenClaw a model the engine already serves',
    );
    expect(screen.getByTestId('agent-model-unsuited-hermes')).toHaveTextContent(
      'On this engine the Hub can only give Hermes a model the engine already serves',
    );
    expect(screen.queryByText(/will download/)).not.toBeInTheDocument();
  });

  it('says nothing when the Default can run every chosen agent', () => {
    const { container } = render(<AgentModelFitNotice model={gemma12b} frameworks={['openclaw', 'hermes']} backend="ollama" {...lists} />);
    expect(container).toBeEmptyDOMElement();
  });
});

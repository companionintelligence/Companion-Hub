import type { CuratedModel } from '@ci-hub/common/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentModelFitNotice } from '../agent-model-fit-notice';

const noTools = {
  id: 'gemma3-270m',
  modality: 'llm',
  displayName: 'Gemma 3 270M',
  metadata: { capabilities: { tools: false } },
  runtime: { contextWindow: 32768 },
} as unknown as CuratedModel;

describe('AgentModelFitNotice', () => {
  it('says the Hub may download a model for the agent on an engine it downloads for', () => {
    render(<AgentModelFitNotice model={noTools} frameworks={['openclaw']} backend="ollama" />);
    expect(screen.getByTestId('agent-model-unsuited-openclaw')).toHaveTextContent('may download one for it');
  });

  // vLLM serves the one model it started with. An app's handout starts no download on oMLX.
  it.each(['vllm', 'omlx'] as const)('does not promise a download on %s', (backend) => {
    render(<AgentModelFitNotice model={noTools} frameworks={['openclaw', 'hermes']} backend={backend} />);
    expect(screen.getByTestId('agent-model-unsuited-openclaw')).toHaveTextContent(
      'On this engine the Hub can only give OpenClaw a model the engine already serves',
    );
    expect(screen.getByTestId('agent-model-unsuited-hermes')).toHaveTextContent(
      'On this engine the Hub can only give Hermes a model the engine already serves',
    );
    expect(screen.queryByText(/may download/)).not.toBeInTheDocument();
  });
});

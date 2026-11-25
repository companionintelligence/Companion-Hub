import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { agentsUnsuitedTo } from '../agent-model-fit';

const llm = (tools: boolean, contextWindow: number) =>
  ({ id: 'm', modality: 'llm', metadata: { capabilities: { tools } }, runtime: { contextWindow } }) as unknown as CuratedModel;

describe('agentsUnsuitedTo', () => {
  it('flags both agents for a model without tool calling', () => {
    expect(agentsUnsuitedTo(llm(false, 131072), ['openclaw', 'hermes'])).toEqual(['openclaw', 'hermes']);
  });

  it('flags only Hermes for a tool-calling model below its 64k window', () => {
    expect(agentsUnsuitedTo(llm(true, 32768), ['openclaw', 'hermes'])).toEqual(['hermes']);
    expect(agentsUnsuitedTo(llm(true, 64000), ['openclaw', 'hermes'])).toEqual([]);
  });

  it('says nothing without a chat model or a chosen agent', () => {
    expect(agentsUnsuitedTo(undefined, ['openclaw'])).toEqual([]);
    expect(agentsUnsuitedTo({ ...llm(false, 0), modality: 'embedding' } as CuratedModel, ['openclaw'])).toEqual([]);
    expect(agentsUnsuitedTo(llm(false, 0), [])).toEqual([]);
  });
});

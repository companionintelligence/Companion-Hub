import { describe, expect, it } from 'vitest';
import type { CuratedModel } from '@ci-hub/common/types';
import { agentModelPlan, agentsUnsuitedTo } from '../agent-model-fit';

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

describe('agentModelPlan', () => {
  const row = (id: string, tools: boolean, contextWindow: number, diskMb: number) =>
    ({
      id,
      backend: 'ollama',
      modality: 'llm',
      metadata: { capabilities: { tools } },
      requirements: { diskMb },
      runtime: { contextWindow, memoryFootprintMb: diskMb },
    }) as unknown as CuratedModel;
  // core-10's lists: 128 GB of unified memory, best first.
  const minimax = row('minimax-m2-community-230b', true, 196608, 53759);
  const qwen = row('qwen3-6-35b', true, 262000, 21573);
  const gemma12b = row('gemma4-12b', true, 256000, 7650);
  const coder = row('qwen3-coder-30b', true, 262144, 18556);
  const gemma4b = row('gemma3-4b', false, 131072, 3300);
  const smallWindow = row('qwen3-8b', true, 40960, 5200);
  const lists = {
    backend: 'ollama' as const,
    availableModels: [gemma4b, smallWindow, gemma12b, coder, qwen, minimax],
    recommendedModels: [minimax, qwen, gemma12b],
  };

  it('downloads the smallest recommended model the agent can run when nothing here suits it', () => {
    expect(agentModelPlan('openclaw', { ...lists, installedIds: ['gemma3-4b'], tickedIds: ['gemma3-4b'] })).toEqual({
      kind: 'download',
      model: gemma12b,
    });
  });

  it('uses a model the engine has before one that is ticked and a ticked one before a download', () => {
    expect(agentModelPlan('openclaw', { ...lists, installedIds: ['gemma3-4b', 'qwen3-6-35b'], tickedIds: ['qwen3-coder-30b'] })).toEqual({
      kind: 'installed',
      model: qwen,
    });
    expect(agentModelPlan('openclaw', { ...lists, installedIds: ['gemma3-4b'], tickedIds: ['gemma3-4b', 'qwen3-coder-30b'] })).toEqual({
      kind: 'ticked',
      model: coder,
    });
  });

  it("skips a model below Hermes' 64k window and has none when no recommendation fits", () => {
    expect(agentModelPlan('hermes', { ...lists, installedIds: ['qwen3-8b'], tickedIds: [] })).toEqual({ kind: 'download', model: gemma12b });
    expect(agentModelPlan('hermes', { ...lists, recommendedModels: [gemma4b], installedIds: [], tickedIds: [] })).toEqual({ kind: 'none' });
  });
});

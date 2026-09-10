import { describe, expect, it } from 'vitest';
import { candidatesForRole, isMlxBuild, mlxAbPair, pickModel } from '../model-select';

describe('isMlxBuild', () => {
  it('matches on a word boundary so a name that merely contains the letters is not mislabelled', () => {
    expect(isMlxBuild('qwen3.5:9b-mlx')).toBe(true);
    expect(isMlxBuild('mlx-community/Qwen3-8B-4bit')).toBe(true);
    expect(isMlxBuild('MLX-Qwen')).toBe(true);
    expect(isMlxBuild('mlxfoo:8b')).toBe(false);
    // `_` is a word character, so an underscore-joined name is NOT matched. Documented, not endorsed:
    // the conservative miss keeps a mislabel out of the comparison, which is the failure that matters.
    expect(isMlxBuild('MLX_Qwen')).toBe(false);
    expect(isMlxBuild('qwen3:8b')).toBe(false);
    expect(isMlxBuild(null)).toBe(false);
  });
});

describe('candidatesForRole', () => {
  const models = ['qwen3:8b', 'nomic-embed-text', 'bge-m3', 'llama3.2:1b', 'all-minilm'];

  it('splits chat from embedding by name, because a probed list carries no modality field', () => {
    expect(candidatesForRole(models, 'embedding')).toEqual(['nomic-embed-text', 'bge-m3', 'all-minilm']);
    expect(candidatesForRole(models, 'chat')).toEqual(['qwen3:8b', 'llama3.2:1b']);
  });
});

describe('pickModel ranking', () => {
  it('picks the smallest declared size, so an eval never drags a 70B into VRAM to say hello', () => {
    expect(pickModel(['llama3:70b', 'qwen3:8b', 'llama3.2:1b'], 'chat')).toBe('llama3.2:1b');
    expect(pickModel(['qwen3:32b', 'qwen3:8b'], 'chat')).toBe('qwen3:8b');
  });

  it('sorts a name that never declares its size last — an unlabelled model never beats a declared small one', () => {
    expect(pickModel(['mystery-model', 'llama3.2:1b'], 'chat')).toBe('llama3.2:1b');
    expect(pickModel(['mystery-model'], 'chat')).toBe('mystery-model');
  });

  it('breaks a size tie on name length so the same inventory always yields the same pick', () => {
    expect(pickModel(['a-very-long-name:1b', 'qq:1b'], 'chat')).toBe('qq:1b');
    expect(pickModel(['qq:1b', 'a-very-long-name:1b'], 'chat')).toBe('qq:1b');
  });

  it('puts MLX above size under the default policy, and ignores it entirely under off', () => {
    const models = ['llama3.2:1b', 'qwen3:8b-mlx'];
    expect(pickModel(models, 'chat')).toBe('qwen3:8b-mlx');
    expect(pickModel(models, 'chat', { policy: 'prefer' })).toBe('qwen3:8b-mlx');
    expect(pickModel(models, 'chat', { policy: 'both' })).toBe('qwen3:8b-mlx');
    expect(pickModel(models, 'chat', { policy: 'off' })).toBe('llama3.2:1b');
  });

  it('lets an operator pin win outright, and returns null rather than substituting when the pin is absent', () => {
    const models = ['llama3.2:1b', 'qwen3:8b', 'qwen3:8b-mlx'];
    expect(pickModel(models, 'chat', { forced: 'qwen3' })).toBe('qwen3:8b');
    expect(pickModel(models, 'chat', { forced: 'qwen3:8b-mlx' })).toBe('qwen3:8b-mlx');
    expect(pickModel(models, 'chat', { forced: 'gemma4' })).toBeNull();
  });

  it('restricts to one half of the A/B when asked, and reports null when that half is empty', () => {
    const models = ['llama3.2:1b', 'qwen3:8b-mlx'];
    expect(pickModel(models, 'chat', { variant: 'mlx' })).toBe('qwen3:8b-mlx');
    expect(pickModel(models, 'chat', { variant: 'std' })).toBe('llama3.2:1b');
    expect(pickModel(['llama3.2:1b'], 'chat', { variant: 'mlx' })).toBeNull();
  });

  it('returns null when the role has no resident candidate — the caller owes a skip row, not a substitute', () => {
    expect(pickModel([], 'chat')).toBeNull();
    expect(pickModel(['nomic-embed-text'], 'chat')).toBeNull();
    expect(pickModel(['qwen3:8b'], 'embedding')).toBeNull();
  });
});

describe('mlxAbPair', () => {
  it('returns both halves only when they are genuinely two different models', () => {
    expect(mlxAbPair(['qwen3:8b', 'qwen3:8b-mlx'], 'chat')).toEqual({ mlx: 'qwen3:8b-mlx', std: 'qwen3:8b' });
  });

  it('returns null rather than a degenerate pair, because a model compared to itself measures nothing', () => {
    expect(mlxAbPair(['qwen3:8b'], 'chat')).toBeNull();
    expect(mlxAbPair(['qwen3:8b-mlx'], 'chat')).toBeNull();
    expect(mlxAbPair([], 'chat')).toBeNull();
  });
});

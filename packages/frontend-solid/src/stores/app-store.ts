import { createSignal } from 'solid-js';
import type { AppCategory } from '@/api-client/types';

export type StoreCategoryFilter = AppCategory | '__alternatives__';

const [search, setSearchRaw] = createSignal('');
const [category, setCategory] = createSignal<StoreCategoryFilter | undefined>();
const [sortDirection, setSortDirection] = createSignal<'asc' | 'desc'>('asc');
const [storeId, setStoreId] = createSignal<string | undefined>();

let searchTimeout: ReturnType<typeof setTimeout>;
function setSearch(value: string) {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => setSearchRaw(value), 300);
}

export const appStoreState = {
  search,
  setSearch,
  category,
  setCategory,
  sortDirection,
  setSortDirection,
  storeId,
  setStoreId,
};

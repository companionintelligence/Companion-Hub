import type { AppCategory } from '@/types/app.types';
import { create } from 'zustand';

export type StoreCategoryFilter = AppCategory | '__alternatives__';

type Store = {
  search: string;
  setSearch: (textSearch: string) => void;
  setSearchImmediate: (textSearch: string) => void;
  category?: StoreCategoryFilter;
  setCategory: (selectedCategory?: StoreCategoryFilter) => void;
  storeId?: string;
  setStoreId: (storeId?: string) => void;
  resetBrowseToFeatured: () => void;
};

const debouncedSearch = (fn: (search: string) => void, delay: number) => {
  let timeoutId: NodeJS.Timeout;
  return (search: string) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(search);
    }, delay);
  };
};

export const useAppStoreState = create<Store>((set) => ({
  category: undefined,
  search: '',
  setSearch: debouncedSearch((search) => set({ search }), 300),
  setSearchImmediate: (search) => set({ search }),
  setCategory: (category) => set({ category }),
  storeId: undefined,
  // Same value, same state object: Zustand then notifies nobody. The store page re-applies the
  // URL's `?store=` on every URL change, and the page subscribes to the whole store.
  setStoreId: (storeId) => set((state) => (state.storeId === storeId ? state : { storeId })),
  resetBrowseToFeatured: () => set({ search: '', category: 'featured' }),
}));

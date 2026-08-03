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
  setStoreId: (storeId) => set({ storeId }),
  resetBrowseToFeatured: () => set({ search: '', category: 'featured' }),
}));

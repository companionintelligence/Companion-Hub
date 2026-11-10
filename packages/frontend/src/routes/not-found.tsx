import { EmptyPage } from '@/components/empty-page/empty-page';

/** Shown inside the Hub's layout, as the empty-state card the rest of the Hub uses. */
export default function NotFoundPage() {
  return (
    <div className="mx-auto max-w-6xl" data-testid="not-found-page">
      <EmptyPage title="NOT_FOUND_TITLE" subtitle="NOT_FOUND_SUBTITLE" redirectPath="/home" actionLabel="COMMON_HOME" />
    </div>
  );
}

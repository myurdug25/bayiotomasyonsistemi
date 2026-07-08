import { CollectionsErrorBoundary } from "@/components/collections/collections-error-boundary";
import { CollectionsPage } from "@/components/collections/collections-page";

export default function CollectionsRoutePage() {
  return (
    <CollectionsErrorBoundary>
      <CollectionsPage />
    </CollectionsErrorBoundary>
  );
}

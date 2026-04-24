/**
 * Hook to check if client-side hydration is complete
 * Use this to prevent hydration mismatches with persisted state
 */

import { useEffect, useState } from 'react';

export function useHasHydrated(): boolean {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  return hasHydrated;
}

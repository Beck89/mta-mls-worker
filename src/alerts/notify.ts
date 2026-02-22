/**
 * Phase 3 alert interface — strictly no-op in Phase 1.
 * The function signature and call site exist, but the body is empty.
 * Phase 3 implements the body; user lookup is handled internally at that point.
 */

export interface AlertEvent {
  type: 'property_updated' | 'property_deleted' | 'price_change' | 'status_change';
  listingKey: string;
  oldValue: string | null;
  newValue: string | null;
}

/**
 * Evaluate whether an alert should be sent for this event.
 * Phase 1: no-op. Does NOT query saved_searches or any Phase 2 tables.
 */
export async function notifyIfNeeded(_event: AlertEvent): Promise<void> {
  // No-op in Phase 1
  // Phase 3 will implement: look up users who saved this property,
  // check saved search criteria, and dispatch notifications.
}

/**
 * Shared utilities for server state and health checks
 */

export const HEARTBEAT_THRESHOLD_MS = 60000; // Increase to 60s for more stability

/**
 * Determines if a server is online based on its last_seen timestamp.
 * Standardizes the "Dead/Alive" logic across the entire application.
 */
export function isServerOnline(lastSeen: string | null): boolean {
  if (!lastSeen) return false;
  
  try {
    const lastSeenDate = new Date(lastSeen);
    const now = new Date();
    
    // Check for Invalid Date
    if (isNaN(lastSeenDate.getTime())) {
      console.warn(`[Utils] Invalid lastSeen date encountered: ${lastSeen}`);
      return false;
    }
    
    const diff = now.getTime() - lastSeenDate.getTime();
    
    // We check if the heartbeat is within the threshold.
    // Using UTC-to-UTC comparison via getTime() is timezone-safe.
    return diff < HEARTBEAT_THRESHOLD_MS;
  } catch (e) {
    console.error('[Utils] Error calculating server status:', e);
    return false;
  }
}

/**
 * Formats the last seen date for display, ensuring it handles nulls gracefully.
 */
export function formatLastSeen(lastSeen: string | null): string {
  if (!lastSeen) return 'Never';
  
  try {
    const date = new Date(lastSeen);
    if (isNaN(date.getTime())) return 'Invalid Date';
    return date.toLocaleString();
  } catch (e) {
    return 'Error';
  }
}

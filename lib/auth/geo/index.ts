/**
 * Geo-IP Module
 *
 * Free geo-IP lookup using ip-api.com with geojs.io fallback.
 */

import axios from "axios";

// ============================================
// Types
// ============================================

export interface GeoLocation {
  country: string;
  city: string;
  countryCode?: string;
}

// ============================================
// Functions
// ============================================

/**
 * Get geo-location for an IP address
 * Uses ip-api.com as primary, geojs.io as fallback
 */
export async function getGeoLocation(ip: string): Promise<GeoLocation | null> {
  // Skip for localhost/private IPs
  if (isPrivateIp(ip)) {
    return { country: "Local", city: "Development", countryCode: "XX" };
  }

  // Primary: ip-api.com (45 req/min free)
  try {
    const res = await axios.get(`http://ip-api.com/json/${ip}`, {
      timeout: 5000,
    });
    if (res.data.status === "success") {
      return {
        country: res.data.country,
        city: res.data.city,
        countryCode: res.data.countryCode,
      };
    }
  } catch {
    // Fall through to backup
  }

  // Fallback: geojs.io
  try {
    const res = await axios.get(`https://get.geojs.io/v1/ip/geo/${ip}.json`, {
      timeout: 5000,
    });
    return {
      country: res.data.country,
      city: res.data.city,
      countryCode: res.data.country_code,
    };
  } catch {
    return null;
  }
}

/**
 * Check if IP is private/local
 */
function isPrivateIp(ip: string): boolean {
  if (!ip || ip === "unknown") return true;

  // Localhost
  if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;

  // Private ranges
  const privateRanges = [
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^fc00:/,
    /^fe80:/,
  ];

  return privateRanges.some((range) => range.test(ip));
}

/**
 * Parse device info from user agent
 */
export function parseDeviceInfo(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  // Simple device detection
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) {
    if (/Mobile/i.test(userAgent)) return "Android Phone";
    return "Android Tablet";
  }
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Macintosh/i.test(userAgent)) return "Mac";
  if (/Linux/i.test(userAgent)) return "Linux";

  return "Unknown device";
}

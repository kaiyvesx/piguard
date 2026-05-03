'use strict';

const { backendApi } = require('./api');

/**
 * GPS Service - Domain-specific methods for GPS functionality.
 */
class GpsService {
  /**
   * Get the current GPS location from the target device.
   * @returns {Promise<{lat: number, lng: number, accuracy?: number, timestamp?: number}>}
   */
  async getCurrentLocation() {
    return backendApi.getGps();
  }

  /**
   * Get GPS tracking history from the target device.
   * @param {object} options - Filter options
   * @param {number} [options.limit] - Maximum number of points to return
   * @param {number} [options.since] - Timestamp to get points since
   * @returns {Promise<Array<{lat: number, lng: number, timestamp: number}>>}
   */
  async getTrackHistory(options = {}) {
    return backendApi.getGpsTrack(options);
  }

  /**
   * Check if GPS data contains a valid location.
   * @param {object} gpsData - GPS data object
   * @returns {boolean}
   */
  isValidLocation(gpsData) {
    if (!gpsData) return false;
    const { lat, lng } = gpsData;
    return (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      lat >= -90 && lat <= 90 &&
      lng >= -180 && lng <= 180
    );
  }

  /**
   * Calculate distance between two GPS points (Haversine formula).
   * @param {object} point1 - First point { lat, lng }
   * @param {object} point2 - Second point { lat, lng }
   * @returns {number} Distance in meters
   */
  calculateDistance(point1, point2) {
    const R = 6371e3; // Earth's radius in meters
    const lat1Rad = point1.lat * Math.PI / 180;
    const lat2Rad = point2.lat * Math.PI / 180;
    const deltaLat = (point2.lat - point1.lat) * Math.PI / 180;
    const deltaLng = (point2.lng - point1.lng) * Math.PI / 180;

    const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
              Math.cos(lat1Rad) * Math.cos(lat2Rad) *
              Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  /**
   * Format GPS coordinates for display.
   * @param {number} lat - Latitude
   * @param {number} lng - Longitude
   * @param {number} [decimals=6] - Number of decimal places
   * @returns {string}
   */
  formatCoordinates(lat, lng, decimals = 6) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(decimals)}${latDir}, ${Math.abs(lng).toFixed(decimals)}${lngDir}`;
  }
}

// Create singleton instance
const gpsService = new GpsService();

module.exports = {
  GpsService,
  gpsService,
};

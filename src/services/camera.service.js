'use strict';

const { backendApi } = require('./api');

/**
 * Camera Service - Domain-specific methods for camera functionality.
 */
class CameraService {
  /**
   * Get list of available cameras on the target device.
   * @returns {Promise<Array<{id: string, name: string, facing: string}>>}
   */
  async getCameras() {
    return backendApi.getCameras();
  }

  /**
   * Take a photo using the target device's camera.
   * @param {object} [options] - Photo options
   * @param {string} [options.camera='back'] - Camera to use ('front' or 'back')
   * @param {number} [options.quality=80] - JPEG quality (1-100)
   * @returns {Promise<{image?: string, url?: string}>}
   */
  async takePhoto(options = {}) {
    const defaults = {
      camera: 'back',
      quality: 80,
    };
    return backendApi.takePhoto({ ...defaults, ...options });
  }

  /**
   * Take a photo with the front camera.
   * @param {object} [options] - Photo options
   * @returns {Promise<{image?: string, url?: string}>}
   */
  async takeSelfie(options = {}) {
    return this.takePhoto({ ...options, camera: 'front' });
  }

  /**
   * Start video recording on the target device.
   * @param {object} [options] - Recording options
   * @param {string} [options.camera='back'] - Camera to use
   * @param {number} [options.duration] - Max duration in seconds
   * @returns {Promise<object>}
   */
  async startRecording(options = {}) {
    return backendApi.startRecording(options);
  }

  /**
   * Stop video recording on the target device.
   * @returns {Promise<{url?: string}>}
   */
  async stopRecording() {
    return backendApi.stopRecording();
  }

  /**
   * Get camera facing direction label.
   * @param {string} facing - Facing value
   * @returns {string}
   */
  getFacingLabel(facing) {
    const labels = {
      back: 'Back Camera',
      front: 'Front Camera',
      external: 'External Camera',
    };
    return labels[facing] || facing || 'Camera';
  }

  /**
   * Parse base64 image data URL.
   * @param {string} dataUrl - Data URL string
   * @returns {{mimeType: string, data: string}|null}
   */
  parseDataUrl(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) {
      return null;
    }

    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return null;
    }

    return {
      mimeType: match[1],
      data: match[2],
    };
  }

  /**
   * Convert base64 to Blob (for downloads, etc).
   * @param {string} base64 - Base64 encoded data
   * @param {string} [mimeType='image/jpeg'] - MIME type
   * @returns {Blob}
   */
  base64ToBlob(base64, mimeType = 'image/jpeg') {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);

    for (let i = 0; i < byteChars.length; i++) {
      byteNumbers[i] = byteChars.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }

  /**
   * Generate a filename for a captured photo.
   * @param {string} [prefix='photo'] - Filename prefix
   * @returns {string}
   */
  generateFilename(prefix = 'photo') {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${prefix}_${timestamp}.jpg`;
  }
}

// Create singleton instance
const cameraService = new CameraService();

module.exports = {
  CameraService,
  cameraService,
};

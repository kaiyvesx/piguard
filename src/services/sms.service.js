'use strict';

const { backendApi } = require('./api');

/**
 * SMS Service - Domain-specific methods for SMS functionality.
 */
class SmsService {
  /**
   * Get SMS messages from the target device.
   * @param {object} [options] - Filter options
   * @param {number} [options.limit] - Maximum number of messages
   * @param {number} [options.since] - Timestamp to get messages since
   * @param {string} [options.threadId] - Specific thread/contact ID
   * @returns {Promise<Array>}
   */
  async getMessages(options = {}) {
    return backendApi.getMessages(options);
  }

  /**
   * Get contacts from the target device.
   * @returns {Promise<Array<{id: string, name: string, phoneNumber: string}>>}
   */
  async getContacts() {
    return backendApi.getContacts();
  }

  /**
   * Send an SMS message from the target device.
   * @param {string|string[]} to - Phone number(s) to send to
   * @param {string} message - Message content
   * @returns {Promise<{sent: boolean}>}
   */
  async sendMessage(to, message) {
    return backendApi.sendSms(to, message);
  }

  /**
   * Format phone number for display.
   * @param {string} phoneNumber - Raw phone number
   * @returns {string}
   */
  formatPhoneNumber(phoneNumber) {
    if (!phoneNumber) return '';

    // Remove non-digit characters except +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');

    // Philippine number formatting (example)
    if (cleaned.startsWith('+63') && cleaned.length === 13) {
      return `+63 ${cleaned.slice(3, 6)} ${cleaned.slice(6, 9)} ${cleaned.slice(9)}`;
    }

    // US number formatting
    if (cleaned.length === 10) {
      return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
    }

    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      return `+1 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
    }

    return phoneNumber;
  }

  /**
   * Group messages by contact/thread.
   * @param {Array} messages - Array of message objects
   * @returns {Map<string, Array>}
   */
  groupMessagesByContact(messages) {
    const groups = new Map();

    for (const msg of messages) {
      const key = msg.address || msg.phoneNumber || 'unknown';
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(msg);
    }

    // Sort messages within each group by timestamp
    for (const [key, msgs] of groups) {
      msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    }

    return groups;
  }

  /**
   * Get the latest message from each contact.
   * @param {Array} messages - Array of message objects
   * @returns {Array}
   */
  getLatestByContact(messages) {
    const groups = this.groupMessagesByContact(messages);
    const results = [];

    for (const [contact, msgs] of groups) {
      const latest = msgs[msgs.length - 1];
      results.push({
        contact,
        latestMessage: latest,
        messageCount: msgs.length,
      });
    }

    // Sort by latest message timestamp (newest first)
    results.sort((a, b) => (b.latestMessage.timestamp || 0) - (a.latestMessage.timestamp || 0));

    return results;
  }

  /**
   * Check if a message is incoming or outgoing.
   * @param {object} message - Message object
   * @returns {boolean} True if incoming
   */
  isIncoming(message) {
    // Common type values: 1 = inbox/received, 2 = sent
    return message.type === 1 || message.type === 'inbox' || message.type === 'received';
  }

  /**
   * Format message timestamp for display.
   * @param {number|string} timestamp - Message timestamp
   * @returns {string}
   */
  formatTimestamp(timestamp) {
    if (!timestamp) return '';

    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // Today: show time only
    if (diff < 24 * 60 * 60 * 1000 && date.getDate() === now.getDate()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Within a week: show day name
    if (diff < 7 * 24 * 60 * 60 * 1000) {
      return date.toLocaleDateString([], { weekday: 'short' });
    }

    // Older: show date
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

// Create singleton instance
const smsService = new SmsService();

module.exports = {
  SmsService,
  smsService,
};

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { RoomCredentials } from '../competition/contracts.js';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptRoomValue(value: string | undefined, key: Buffer | undefined): Buffer | null {
  if (!value) return null;
  if (!key) throw new Error('Room credential encryption is not configured.');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptRoomValues(encryptedRoomId: Buffer, encryptedPassword: Buffer, key: Buffer | undefined): RoomCredentials {
  if (!key) throw new Error('Room credential encryption is not configured.');
  return {
    roomId: encryptedRoomId.length ? decryptRoomValue(encryptedRoomId, key) : '',
    roomPassword: encryptedPassword.length ? decryptRoomValue(encryptedPassword, key) : ''
  };
}

function decryptRoomValue(value: Buffer, key: Buffer): string {
  if (value.length < IV_LENGTH + TAG_LENGTH) throw new Error('Encrypted room credential is invalid.');
  const iv = value.subarray(0, IV_LENGTH);
  const tag = value.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = value.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
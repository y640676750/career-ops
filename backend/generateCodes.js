#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { generateActivationCodes } from './src/data/activationStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const count = parsePositiveInt(process.argv[2], 50);
const validDays = parsePositiveInt(process.argv[3], 1);
const codes = generateActivationCodes({ count, validDays });
const outputFile = path.join(__dirname, 'storage', `activation-codes-${Date.now()}.txt`);

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${codes.join('\n')}\n`, 'utf8');

console.log(`Generated ${codes.length} activation codes, validDays=${validDays}`);
console.log(`Saved to ${outputFile}`);
console.log(codes.join('\n'));

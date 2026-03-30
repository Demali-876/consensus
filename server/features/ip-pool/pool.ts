import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyDeviceIps,
  dedupeAndTrimHistory,
  resolveCurrentObservation,
  type DeviceIpClue,
  type DeviceIpObservation,
} from './detector.js';

const DEFAULT_HISTORY_PATH =
  process.env.IP_POOL_HISTORY_PATH || path.resolve(process.cwd(), 'ip-pool-history.json');

export interface DepositObservationOptions {
  history?: DeviceIpObservation[];
  historyPath?: string;
  persist?: boolean;
}

export interface DetectAndDepositOptions extends DepositObservationOptions {
  reverseDns?: boolean;
}

export function loadPoolHistory(historyPath = DEFAULT_HISTORY_PATH): DeviceIpObservation[] {
  try {
    const raw = fs.readFileSync(historyPath, 'utf8');
    const parsed = JSON.parse(raw) as { observations?: DeviceIpObservation[] } | DeviceIpObservation[];
    const observations = Array.isArray(parsed) ? parsed : (parsed.observations ?? []);
    return dedupeAndTrimHistory(observations);
  } catch {
    return [];
  }
}

export function savePoolHistory(
  observations: DeviceIpObservation[],
  historyPath = DEFAULT_HISTORY_PATH,
): DeviceIpObservation[] {
  const normalized = dedupeAndTrimHistory(observations);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({ observations: normalized }, null, 2), 'utf8');
  return normalized;
}

export function depositObservation(
  observation: DeviceIpObservation,
  options: DepositObservationOptions = {},
): { clue: DeviceIpClue; history: DeviceIpObservation[] } {
  const history =
    options.history ??
    (options.persist !== false ? loadPoolHistory(options.historyPath) : []);
  const nextHistory = dedupeAndTrimHistory([...history, observation]);

  if (options.persist !== false) {
    savePoolHistory(nextHistory, options.historyPath);
  }

  return {
    clue: classifyDeviceIps({ current: observation, history }),
    history: nextHistory,
  };
}

export async function detectAndDepositObservation(
  options: DetectAndDepositOptions = {},
): Promise<{ clue: DeviceIpClue; observation: DeviceIpObservation; history: DeviceIpObservation[] }> {
  const observation = await resolveCurrentObservation({ reverseDns: options.reverseDns });
  const { clue, history } = depositObservation(observation, options);
  return { clue, observation, history };
}

async function runCli(): Promise<void> {
  const result = await detectAndDepositObservation();
  console.log(JSON.stringify(result.clue, null, 2));
}

const isDirectExecution =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  void runCli();
}
